import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectInstructions } from "../../extensions/auto-mode/instructions.ts";

let root: string;
let repo: string;
let nested: string;
let home: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-instr-"));
	repo = join(root, "repo");
	nested = join(repo, "packages", "app");
	home = join(root, "home");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(nested, { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("loadProjectInstructions", () => {
	it("returns undefined when there are no instruction files", () => {
		expect(loadProjectInstructions(repo, home)).toBeUndefined();
	});

	it("reads CLAUDE.md from the working directory", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "Never force push.");
		const loaded = loadProjectInstructions(repo, home);
		expect(loaded).toContain("Never force push.");
		expect(loaded).toContain("CLAUDE.md");
	});

	it("walks up to the git root, nearest file first", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "ROOT RULE");
		writeFileSync(join(nested, "CLAUDE.md"), "NESTED RULE");
		const loaded = loadProjectInstructions(nested, home) ?? "";
		expect(loaded.indexOf("NESTED RULE")).toBeLessThan(loaded.indexOf("ROOT RULE"));
	});

	it("does not walk past the git root", () => {
		writeFileSync(join(root, "CLAUDE.md"), "OUTSIDE REPO");
		writeFileSync(join(repo, "CLAUDE.md"), "IN REPO");
		const loaded = loadProjectInstructions(repo, home) ?? "";
		expect(loaded).toContain("IN REPO");
		expect(loaded).not.toContain("OUTSIDE REPO");
	});

	it("includes AGENTS.md and the user's global file", () => {
		writeFileSync(join(repo, "AGENTS.md"), "AGENTS CONTENT");
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "GLOBAL CONTENT");
		const loaded = loadProjectInstructions(repo, home) ?? "";
		expect(loaded).toContain("AGENTS CONTENT");
		expect(loaded).toContain("GLOBAL CONTENT");
	});

	it("caps a large file so it cannot crowd out the rules", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "x".repeat(200_000));
		const loaded = loadProjectInstructions(repo, home) ?? "";
		expect(loaded.length).toBeLessThan(15_000);
	});
});
