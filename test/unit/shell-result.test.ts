/**
 * Foreground shell results in Claude Code's words (lib/shell-result.ts): a
 * failure starts with `Exit code N`, output loses its trailing newline, an
 * empty success names the tool. The inputs are pi's exact texts.
 */
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { claudeCodeShellText } from "../../extensions/lib/shell-result.ts";
import { registerShellTool } from "../../extensions/lib/shell-tool.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("claudeCodeShellText", () => {
	it("puts the exit code first on a failure, without pi's trailer", () => {
		expect(claudeCodeShellText("ls: /nonexistent-dir: No such file or directory\n\n\nCommand exited with code 1", 1, "bash")).toBe(
			"Exit code 1\nls: /nonexistent-dir: No such file or directory",
		);
		expect(claudeCodeShellText("(no output)\n\nCommand exited with code 3", 3, "bash")).toBe("Exit code 3");
		expect(claudeCodeShellText("\nx\n\n\nCommand exited with code 4", 4, "bash")).toBe("Exit code 4\n\nx");
	});

	it("trims a success's leading blank lines and trailing whitespace", () => {
		expect(claudeCodeShellText("hi\ngoodbye\n", 0, "bash")).toBe("hi\ngoodbye");
		expect(claudeCodeShellText("\n  \napp.py\nREADME.md\n\n", 0, "powershell")).toBe("app.py\nREADME.md");
	});

	it("names the tool for an empty success", () => {
		expect(claudeCodeShellText("(no output)", 0, "bash")).toBe("(Bash completed with no output)");
		expect(claudeCodeShellText("(no output)", 0, "powershell")).toBe("(PowerShell completed with no output)");
	});

	it("marks a success whose output becomes empty after Claude Code's trimming", () => {
		expect(claudeCodeShellText(" \n\t\n", 0, "bash")).toBe("(Bash completed with no output)");
	});

	it("keeps pi's text when the shape is not pi's", () => {
		expect(claudeCodeShellText("Command timed out after 2 seconds", undefined, "bash")).toBeUndefined();
		expect(claudeCodeShellText("odd text", 2, "bash")).toBeUndefined();
	});
});

describe("registerShellTool: the foreground result reads as Claude Code's", () => {
	const mount = (result: unknown, name: "bash" | "powershell" = "bash") => {
		const fake = createFakePi();
		registerShellTool(fake.pi as never, {
			name,
			ccLabel: name === "bash" ? "Bash" : "PowerShell",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "Bash" },
			foreground: () => ({ execute: vi.fn(async () => result) }),
			guard: () => undefined,
			backgroundShell: () => undefined,
		});
		return (command: string) => fake.tools.get(name)!.execute("c1", { command }, undefined, undefined, createFakeCtx({ mode: "tui" })) as Promise<{
			content: Array<{ text: string }>;
			isError?: boolean;
			structuredContent?: unknown;
		}>;
	};

	it("rewrites a failure and keeps the error flag and structured content", async () => {
		const structuredContent = { output: "boom\n", truncated: false, exit_code: 2, wall_time_seconds: 0.1 };
		const run = mount({ content: [{ type: "text", text: "boom\n\n\nCommand exited with code 2" }], details: {}, structuredContent, isError: true });
		const result = await run("false");
		expect(result.content[0].text).toBe("Exit code 2\nboom");
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBe(structuredContent);
	});

	it("persists an output past Claude Code's inline cap, head first", async () => {
		const output = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}`).join("\n");
		const run = mount({ content: [{ type: "text", text: output }], details: {}, structuredContent: { output, truncated: false, exit_code: 0, wall_time_seconds: 0 } });
		const text = (await run("cat big")).content[0].text;
		expect(text.startsWith("<persisted-output>\nOutput too large (")).toBe(true);
		expect(text).toContain("Preview (first 2KB):\nline 1\nline 2\n");
	});

	it("trims a success", async () => {
		const run = mount({ content: [{ type: "text", text: "hi\n" }], details: {}, structuredContent: { output: "hi\n", truncated: false, exit_code: 0, wall_time_seconds: 0 } });
		expect((await run("echo hi")).content[0].text).toBe("hi");
	});

	it.each(["grep absent file", "rg absent file", "egrep absent file", "fgrep absent file", "find file", "diff a b", "test -e file", "[ -e file ]", "git grep absent", "git -C root diff --quiet", "git --git-dir .git --work-tree . diff --quiet", "echo one | rg absent", "echo one; rg absent", "echo one || rg absent"])("marks a blank semantic-success exit 1 for %s", async (command) => {
		const run = mount({ content: [{ type: "text", text: "(no output)\n\nCommand exited with code 1" }], structuredContent: { output: "", exit_code: 1 }, isError: true });
		const result = await run(command);
		expect(result.content[0].text).toBe("(Bash completed with no output)");
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toEqual({ output: "", exit_code: 1 });
	});

	it.each(["false", "false && rg absent", "env rg absent", "/usr/bin/grep absent file", "git status", `rg ${"x".repeat(10_000)}`])("keeps an ordinary blank failure for %s", async (command) => {
		const run = mount({ content: [{ type: "text", text: "(no output)\n\nCommand exited with code 1" }], structuredContent: { output: "", exit_code: 1 }, isError: true });
		const result = await run(command);
		expect(result.content[0].text).toBe("Exit code 1");
		expect(result.isError).toBe(true);
	});

	// As in Claude Code: `diff a.txt b.txt` that prints a change and exits 1
	// is a plain, non-error result with no exit line.
	it.each([
		["diff a.txt b.txt", "1c1\n< hello\n---\n> hellO"],
		["grep -c absent README.md", "0"],
		["git diff --stat main", " a.txt | 2 +-"],
	])("reads a semantic-success exit 1 with output as plain output for %s", async (command, output) => {
		const run = mount({ content: [{ type: "text", text: `${output}\n\n\nCommand exited with code 1` }], structuredContent: { output: `${output}\n`, exit_code: 1 }, isError: true });
		const result = await run(command);
		expect(result.content[0].text).toBe(output);
		expect(result.isError).toBe(false);
	});

	it.each([
		["diff a.txt b.txt", 2],
		["false && diff a.txt b.txt", 1],
		["cat a.txt", 1],
	])("keeps a failure with output for %s exiting %i", async (command, code) => {
		const run = mount({ content: [{ type: "text", text: `boom\n\n\nCommand exited with code ${code}` }], structuredContent: { output: "boom\n", exit_code: code }, isError: true });
		const result = await run(command);
		expect(result.content[0].text).toBe(`Exit code ${code}\nboom`);
		expect(result.isError).toBe(true);
	});
});

describe("registerShellTool: PowerShell's semantic exit codes, as Claude Code's", () => {
	const mount = (text: string, code: number) => {
		const fake = createFakePi();
		registerShellTool(fake.pi as never, {
			name: "powershell",
			ccLabel: "PowerShell",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "PowerShell" },
			foreground: () => ({ execute: vi.fn(async () => ({ content: [{ type: "text", text: text ? `${text}\n\n\nCommand exited with code ${code}` : `(no output)\n\nCommand exited with code ${code}` }], structuredContent: { output: text, exit_code: code }, isError: true })) }),
			guard: () => undefined,
			backgroundShell: () => undefined,
		});
		return (command: string) => fake.tools.get("powershell")!.execute("c1", { command }, undefined, undefined, createFakeCtx({ mode: "tui" })) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
	};

	it.each([
		["findstr absent notes.txt", "", 1, "(PowerShell completed with no output)"],
		["rg absent", "", 1, "(PowerShell completed with no output)"],
		["& 'C:\\Tools\\rg.exe' absent", "", 1, "(PowerShell completed with no output)"],
		["robocopy src dst /E", "  Files : 3", 3, "  Files : 3"],
		["robocopy src dst /E", "  Files : 3", 7, "  Files : 3"],
		["where.exe node", "INFO: Could not find files for the given pattern(s).", 1, "INFO: Could not find files for the given pattern(s)."],
		["fc.exe a.txt b.txt", "***** a.txt", 1, "***** a.txt"],
		["git -C repo diff --quiet", "", 1, "(PowerShell completed with no output)"],
		["git --git-dir .git --work-tree . diff --quiet", "", 1, "(PowerShell completed with no output)"],
		["Get-ChildItem; grep absent notes.txt", "a.txt", 1, "a.txt"],
	])("reads %s (output %j, exit %i) as a success", async (command, output, code, expected) => {
		const result = await mount(output, code)(command);
		expect(result.content[0].text).toBe(expected);
		expect(result.isError).toBe(false);
	});

	it.each([
		["robocopy src dst /E", "ERROR 5", 8],
		["rg absent", "", 2],
		["where node", "x", 1],
		["where.exe node", "", 1],
		["fc a.txt b.txt", "***** a.txt", 1],
		["Test-Path x && rg absent", "", 1],
		["rg absent", "rg : The term 'rg' is not recognized as a name of a cmdlet", 1],
		["findstr absent notes.txt", "FINDSTR: Cannot open notes.txt", 1],
		["Remove-Item x", "", 1],
	])("keeps %s (output %j, exit %i) an error", async (command, output, code) => {
		const result = await mount(output, code)(command);
		expect(result.content[0].text.startsWith(`Exit code ${code}`)).toBe(true);
		expect(result.isError).toBe(true);
	});
});
