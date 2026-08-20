import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryEntries } from "../../extensions/memory/entries.ts";

describe("buildMemoryEntries", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mem-entries-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const write = (rel: string, content = "x") => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	};

	function build(cwd: string) {
		return buildMemoryEntries({
			cwd,
			home: root,
			homeClaudeDir: join(root, ".claude"),
			homeOneCodeDir: join(root, ".onecode"),
			memoryDir: join(root, "mem"),
		});
	}

	it("always offers the global user CLAUDE.md and project CLAUDE.md, even when absent", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const entries = build(cwd);
		const user = entries.find((e) => e.title === "User instructions");
		const project = entries.find((e) => e.title === "Project instructions");
		expect(user).toMatchObject({ path: join(root, ".claude", "CLAUDE.md"), exists: false });
		expect(project).toMatchObject({ path: join(cwd, "CLAUDE.md"), exists: false });
	});

	it("describes cwd files as ./name (CC's relative form), not the absolute path", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const entries = build(cwd);
		const project = entries.find((e) => e.title === "Project instructions");
		expect(project?.description).toBe("Checked in at ./CLAUDE.md");
	});

	it("shows AGENTS.md only when a loaded file @-imports it; ONECODE.md always", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		write("proj/CLAUDE.md", "@AGENTS.md\n"); // references AGENTS.md
		write("proj/AGENTS.md");
		write("proj/ONECODE.md");
		const entries = build(cwd);
		expect(entries).toContainEqual(
			expect.objectContaining({ title: "Agent instructions", path: join(cwd, "AGENTS.md") }),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({ title: "One Code instructions", path: join(cwd, "ONECODE.md") }),
		);
	});

	it("omits AGENTS.md when a CLAUDE.md exists and does not import it (CLAUDE.md wins)", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		write("proj/CLAUDE.md", "# Project\n"); // no @AGENTS.md import
		write("proj/AGENTS.md");
		const entries = build(cwd);
		expect(entries.some((e) => e.path === join(cwd, "AGENTS.md"))).toBe(false);
	});

	it("shows AGENTS.md as the fallback when the directory has no CLAUDE.md", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		write("proj/AGENTS.md"); // no CLAUDE.md here
		const entries = build(cwd);
		expect(entries).toContainEqual(
			expect.objectContaining({ title: "Agent instructions", path: join(cwd, "AGENTS.md") }),
		);
	});

	it("includes a global ONECODE.md and ends with the auto-memory folder", () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const globalOneCode = write(".onecode/ONECODE.md");
		const entries = build(cwd);
		expect(entries).toContainEqual(
			expect.objectContaining({ title: "One Code user instructions", path: globalOneCode }),
		);
		const last = entries[entries.length - 1];
		expect(last).toMatchObject({ title: "Open auto-memory folder", kind: "folder", path: join(root, "mem") });
	});

	it("shows ancestor CLAUDE.md files by path, farthest first, before the project one", () => {
		const cwd = join(root, "a", "b");
		mkdirSync(cwd, { recursive: true });
		write("a/CLAUDE.md");
		const entries = build(cwd);
		const ancestorIdx = entries.findIndex((e) => e.path === join(root, "a", "CLAUDE.md"));
		const projectIdx = entries.findIndex((e) => e.title === "Project instructions");
		expect(ancestorIdx).toBeGreaterThanOrEqual(0);
		expect(ancestorIdx).toBeLessThan(projectIdx);
		// Ancestor entries are labelled by their (tildified) path, not a friendly name.
		expect(entries[ancestorIdx].title).toBe("~/a/CLAUDE.md");
	});
});
