/**
 * Claude Code's nested instructions: reading a file below the working
 * directory attaches the instruction files of the directories in between,
 * once each (lib/claude-context.ts nestedInstructionFiles, claude-context/index.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { nestedInstructionFiles, nestedInstructionText } from "../../extensions/lib/claude-context.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nested-instructions-"));
	mkdirSync(join(root, "src", "reports", "deep"), { recursive: true });
	writeFileSync(join(root, "CLAUDE.md"), "root rules\n");
	writeFileSync(join(root, "src", "reports", "CLAUDE.md"), "Amounts are integer cents.\n");
	writeFileSync(join(root, "src", "reports", "CLAUDE.local.md"), "local note\n");
	writeFileSync(join(root, "src", "reports", "summary.py"), "def summarize(): ...\n");
	writeFileSync(join(root, "src", "reports", "deep", "x.py"), "x = 1\n");
	writeFileSync(join(root, "src", "a.py"), "a = 1\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const files = (filePath: string, rule: "claude-md" | "agents-md" = "claude-md") =>
	nestedInstructionFiles({ filePath, cwd: root, rule, home: root }).map((f) => f.path);

describe("nestedInstructionFiles", () => {
	it("returns the directories between cwd and the file, never cwd's own files", () => {
		expect(files(join(root, "src", "reports", "summary.py"))).toEqual([join(root, "src", "reports", "CLAUDE.md"), join(root, "src", "reports", "CLAUDE.local.md")]);
		expect(files(join(root, "src", "reports", "deep", "x.py"))).toEqual([join(root, "src", "reports", "CLAUDE.md"), join(root, "src", "reports", "CLAUDE.local.md")]);
		expect(files(join(root, "src", "a.py"))).toEqual([]);
		expect(files(join(root, "README.md"))).toEqual([]);
	});

	it("ignores files outside the working directory and the instruction file being read", () => {
		expect(files("/etc/hosts")).toEqual([]);
		expect(files(join(root, "src", "reports", "CLAUDE.md"))).toEqual([join(root, "src", "reports", "CLAUDE.local.md")]);
	});

	it("follows the instruction rule: independent mode reads AGENTS.md only", () => {
		writeFileSync(join(root, "src", "reports", "AGENTS.md"), "agents rules\n");
		expect(files(join(root, "src", "reports", "summary.py"), "agents-md")).toEqual([join(root, "src", "reports", "AGENTS.md")]);
	});

	it("renders Claude Code's nested_memory text", () => {
		expect(nestedInstructionText({ path: "/p/src/CLAUDE.md", content: "rule\n" })).toBe("Contents of /p/src/CLAUDE.md:\n\nrule\n");
	});
});

describe("claude-context: a read attaches nested instructions once", () => {
	it("queues each file on the first read below it, and not again", async () => {
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		const texts: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const payload = data as { text?: string; placement?: string };
			if (!payload.placement && payload.text) texts.push(payload.text);
		});
		const ctx = createFakeCtx({ cwd: root });
		const read = (path: string) => fake.fire("tool_result", { toolName: "read", input: { path }, isError: false, content: [] }, ctx);
		await read("src/reports/summary.py");
		await read("src/reports/deep/x.py");
		expect(texts).toEqual([`Contents of ${join(root, "src", "reports", "CLAUDE.md")}:\n\nAmounts are integer cents.\n`, `Contents of ${join(root, "src", "reports", "CLAUDE.local.md")}:\n\nlocal note\n`]);
	});
});
