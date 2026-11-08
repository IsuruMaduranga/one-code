/**
 * The /memory panel's rows (memory/entries.ts): the instruction files a user
 * writes, for the profile in force (lib/instructions.ts instructionTargets),
 * always offered; ancestors by path before the project's own; the auto-memory
 * folder last. With One Code's source provider (Claude Code's files):
 * profile/test/memory-entries-claude-code.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brand } from "../../extensions/lib/brand.mjs";
import { instructionTargets } from "../../extensions/lib/instructions.ts";
import { buildMemoryEntries } from "../../extensions/memory/entries.ts";

describe("buildMemoryEntries", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mem-entries-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const stateDir = () => join(root, brand.stateDir);
	/** The files a user writes, as the panel resolves them. */
	const targets = () => instructionTargets(root, stateDir());

	const write = (rel: string, content = "x") => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	};

	function build(cwd: string) {
		return buildMemoryEntries({ agentDir: undefined,
			cwd,
			home: root,
			homeOneCodeDir: stateDir(),
			memoryDir: join(root, "mem"),
		});
	}

	it("always offers the user and project instruction files, even when absent", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const entries = build(cwd);
		const user = entries.find((e) => e.title === "User instructions");
		const project = entries.find((e) => e.title === "Project instructions");
		expect(user).toMatchObject({ path: targets().user, exists: false });
		expect(project).toMatchObject({ path: join(cwd, targets().project), exists: false });
	});

	it("describes cwd files as ./name (CC's relative form), not the absolute path", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const entries = build(cwd);
		const project = entries.find((e) => e.title === "Project instructions");
		expect(project?.description).toBe(`Checked in at ./${targets().project}`);
	});

	it("marks the project file present once it exists, and ends with the auto-memory folder", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		write(join("proj", targets().project));
		const entries = build(cwd);
		expect(entries.find((e) => e.title === "Project instructions")).toMatchObject({ path: join(cwd, targets().project), exists: true });
		const last = entries[entries.length - 1];
		expect(last).toMatchObject({ title: "Open auto-memory folder", kind: "folder", path: join(root, "mem") });
	});

	it("shows ancestor project files by path, farthest first, before the project one", () => {
		const cwd = join(root, "a", "b");
		mkdirSync(cwd, { recursive: true });
		write(join("a", targets().project));
		const entries = build(cwd);
		const ancestorIdx = entries.findIndex((e) => e.path === join(root, "a", targets().project));
		const projectIdx = entries.findIndex((e) => e.title === "Project instructions");
		expect(ancestorIdx).toBeGreaterThanOrEqual(0);
		expect(ancestorIdx).toBeLessThan(projectIdx);
		// Ancestor entries are labelled by their (tildified) path, not a friendly name.
		expect(entries[ancestorIdx].title).toBe(`~/a/${targets().project}`);
	});
});
