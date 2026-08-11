import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listMemoryFiles, prepareMemorySave } from "../../extensions/memory/files.ts";
import { INDEX_NEAR_LIMIT_REMINDER, INDEX_OVER_LIMIT_ERROR, projectMemoryDir } from "../../extensions/lib/memory.ts";

const root = mkdtempSync(join(tmpdir(), "cc-mem-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Isolate HOME so projectMemoryDir + the global CLAUDE.md resolve inside the tmp
// tree, and nothing touches the real user config.
const home = join(root, "home");
const homeClaude = join(home, ".claude");
const cwd = join(root, "repo");
mkdirSync(homeClaude, { recursive: true });
mkdirSync(cwd, { recursive: true });

describe("listMemoryFiles", () => {
	it("offers the project targets, marking absent ones exists:false", () => {
		const files = listMemoryFiles({ cwd, homeClaudeDir: homeClaude, home });
		const project = files.find((f) => f.path === join(cwd, "CLAUDE.md"));
		const local = files.find((f) => f.path === join(cwd, "CLAUDE.local.md"));
		expect(project).toBeDefined();
		expect(local).toBeDefined();
		expect(project?.exists).toBe(false); // not created yet
	});

	it("never offers the global ~/.claude/CLAUDE.md — .claude is a read-only compat surface", () => {
		// Even when it exists on disk, it must not be an editable target.
		writeFileSync(join(homeClaude, "CLAUDE.md"), "# global\n");
		const files = listMemoryFiles({ cwd, homeClaudeDir: homeClaude, home });
		expect(files.some((f) => f.path === join(homeClaude, "CLAUDE.md"))).toBe(false);
	});

	it("reflects existence and lists memory dir files with MEMORY.md first", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "# CLAUDE.md\n");
		const memDir = projectMemoryDir(cwd, home);
		mkdirSync(memDir, { recursive: true });
		writeFileSync(join(memDir, "MEMORY.md"), "# index\n");
		writeFileSync(join(memDir, "a-fact.md"), "fact\n");

		const files = listMemoryFiles({ cwd, homeClaudeDir: homeClaude, home });
		expect(files.find((f) => f.path === join(cwd, "CLAUDE.md"))?.exists).toBe(true);

		const memEntries = files.filter((f) => f.label.startsWith("memory/"));
		expect(memEntries.map((f) => f.label)).toEqual(["memory/MEMORY.md", "memory/a-fact.md"]);
	});

	it("does not duplicate a path across sources", () => {
		const files = listMemoryFiles({ cwd, homeClaudeDir: homeClaude, home });
		const paths = files.map((f) => f.path);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("suffixes absent targets with (create) in displayLabel, not present ones", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "# CLAUDE.md\n");
		const files = listMemoryFiles({ cwd, homeClaudeDir: homeClaude, home });
		const project = files.find((f) => f.path === join(cwd, "CLAUDE.md"));
		const local = files.find((f) => f.path === join(cwd, "CLAUDE.local.md"));
		expect(project?.displayLabel).toBe(project?.label); // exists → no suffix
		expect(local?.displayLabel).toBe(`${local?.label}  (create)`); // absent → suffix
	});
});

describe("prepareMemorySave", () => {
	const args = { cwd, sessionId: "sess-123", nowIso: "2026-08-11T00:00:00.000Z", home };

	it("does not stamp or warn for a project CLAUDE.md write", () => {
		const plan = prepareMemorySave({ ...args, path: join(cwd, "CLAUDE.md"), content: "# CLAUDE.md\nhi\n" });
		expect(plan.content).toBe("# CLAUDE.md\nhi\n");
		expect(plan.warning).toBeUndefined();
	});

	it("stamps frontmatter for a write under the memory dir", () => {
		const memDir = projectMemoryDir(cwd, home);
		const content = "---\nname: a-fact\nmetadata:\n  type: project\n---\n\nbody\n";
		const plan = prepareMemorySave({ ...args, path: join(memDir, "a-fact.md"), content });
		expect(plan.content).toContain("originSessionId: sess-123");
		expect(plan.content).toContain("modified: 2026-08-11T00:00:00.000Z");
	});

	it("warns when a saved MEMORY.md index is over the load limit", () => {
		const memDir = projectMemoryDir(cwd, home);
		const overLimit = `${Array.from({ length: 250 }, (_, i) => `- line ${i}`).join("\n")}\n`;
		const plan = prepareMemorySave({ ...args, path: join(memDir, "MEMORY.md"), content: overLimit });
		expect(plan.warning).toBe(INDEX_OVER_LIMIT_ERROR);
	});

	it("does not warn for a short MEMORY.md index", () => {
		const memDir = projectMemoryDir(cwd, home);
		const plan = prepareMemorySave({ ...args, path: join(memDir, "MEMORY.md"), content: "# index\n- one\n" });
		expect(plan.warning).toBeUndefined();
		expect(plan.warning).not.toBe(INDEX_NEAR_LIMIT_REMINDER);
	});
});
