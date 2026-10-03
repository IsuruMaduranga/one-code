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
		expect(claudeCodeShellText("(no output)", 0, "bash")).toBe("(bash completed with no output)");
		expect(claudeCodeShellText("(no output)", 0, "powershell")).toBe("(powershell completed with no output)");
	});

	it("keeps pi's text when the shape is not pi's", () => {
		expect(claudeCodeShellText("Command timed out after 2 seconds", undefined, "bash")).toBeUndefined();
		expect(claudeCodeShellText("odd text", 2, "bash")).toBeUndefined();
	});
});

describe("registerShellTool: the foreground result reads as Claude Code's", () => {
	const mount = (result: unknown) => {
		const fake = createFakePi();
		registerShellTool(fake.pi as never, {
			name: "bash",
			ccLabel: "Bash",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "Bash" },
			foreground: () => ({ execute: vi.fn(async () => result) }),
			guard: () => undefined,
			backgroundShell: () => undefined,
		});
		return (command: string) => fake.tools.get("bash")!.execute("c1", { command }, undefined, undefined, createFakeCtx({ mode: "tui" })) as Promise<{
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

	it("trims a success", async () => {
		const run = mount({ content: [{ type: "text", text: "hi\n" }], details: {}, structuredContent: { output: "hi\n", truncated: false, exit_code: 0, wall_time_seconds: 0 } });
		expect((await run("echo hi")).content[0].text).toBe("hi");
	});
});
