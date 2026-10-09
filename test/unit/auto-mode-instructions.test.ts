import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectInstructions } from "../../extensions/auto-mode/instructions.ts";
import { buildClaudeMdBlock, discoverContextFiles, instructionRule } from "../../extensions/lib/claude-context.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";

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

	it("reads AGENTS.md beside CLAUDE.md in compatible mode, whatever instructionFiles picks for the agent", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "claude rule");
		writeFileSync(join(repo, "AGENTS.md"), "never push to main");
		const text = loadProjectInstructions(repo, home) ?? "";
		expect(text).toContain("claude rule");
		expect(text).toContain("never push to main");
	});

	it("reads the project's and the global ONECODE.md in both modes", () => {
		writeFileSync(join(repo, "ONECODE.md"), "never deploy from here");
		const state = join(root, "state");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "ONECODE.md"), "global one code rule");
		process.env.ONECODE_STATE_DIR = state;
		try {
			for (const mode of ["claude-compatible", "independent"] as const) {
				resetConfigModeForTest(mode);
				const text = loadProjectInstructions(repo, home) ?? "";
				expect(text).toContain("never deploy from here");
				expect(text).toContain("global one code rule");
			}
		} finally {
			delete process.env.ONECODE_STATE_DIR;
		}
	});

	it("reads only AGENTS.md in independent mode", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "claude rule");
		writeFileSync(join(repo, "AGENTS.md"), "agents rule");
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "global rule");
		resetConfigModeForTest("independent");
		const text = loadProjectInstructions(repo, home) ?? "";
		expect(text).toContain("agents rule");
		expect(text).not.toContain("claude rule");
		expect(text).not.toContain("global rule");
	});

	it("reads CLAUDE.md from the working directory", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "Never force push.");
		const loaded = loadProjectInstructions(repo, home);
		expect(loaded).toContain("Never force push.");
		expect(loaded).toContain("CLAUDE.md");
	});

	it("walks up every ancestor in the agent's order, farthest first", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "ROOT RULE");
		writeFileSync(join(nested, "CLAUDE.md"), "NESTED RULE");
		const loaded = loadProjectInstructions(nested, home) ?? "";
		expect(loaded.indexOf("ROOT RULE")).toBeLessThan(loaded.indexOf("NESTED RULE"));
	});

	it("reads an ancestor above the git root, as the agent does", () => {
		writeFileSync(join(root, "CLAUDE.md"), "OUTSIDE REPO");
		writeFileSync(join(repo, "CLAUDE.md"), "IN REPO");
		const loaded = loadProjectInstructions(repo, home) ?? "";
		expect(loaded).toContain("IN REPO");
		expect(loaded).toContain("OUTSIDE REPO");
	});

	// Claude Code's classifier gets the agent's CLAUDE.md whole; a cut would drop restrictions.
	it("passes every file whole, path-conditional rules included, however large the rest", () => {
		mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
		writeFileSync(join(repo, ".claude", "rules", "db.md"), "---\npaths: src/db/**\n---\nNever run migrations against production.");
		const global = `GLOBAL ${"g".repeat(20_000)} END GLOBAL`;
		writeFileSync(join(home, ".claude", "CLAUDE.md"), global);
		writeFileSync(join(repo, "CLAUDE.md"), `ROOT ${"r".repeat(200_000)} END ROOT`);
		writeFileSync(join(nested, "CLAUDE.md"), "NESTED: never run migrations.");
		const loaded = loadProjectInstructions(nested, home) ?? "";
		expect(loaded).toContain("Never run migrations against production.");
		expect(loaded).toContain(global);
		expect(loaded).toContain(`ROOT ${"r".repeat(200_000)} END ROOT`);
		expect(loaded).toContain("NESTED: never run migrations.");
	});

	it("includes AGENTS.md and the user's global file", () => {
		writeFileSync(join(repo, "AGENTS.md"), "AGENTS CONTENT");
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "GLOBAL CONTENT");
		const loaded = loadProjectInstructions(repo, home) ?? "";
		expect(loaded).toContain("AGENTS CONTENT");
		expect(loaded).toContain("GLOBAL CONTENT");
	});

	// The agent loads these (lib/claude-context.ts); the classifier must see the same restriction.
	it.each([
		[".claude/CLAUDE.md", join(".claude", "CLAUDE.md")],
		["an unconditional .claude/rules file", join(".claude", "rules", "safety.md")],
	])("carries a restriction in %s to both the agent and the classifier", (_label, relative) => {
		mkdirSync(join(repo, relative, ".."), { recursive: true });
		writeFileSync(join(repo, relative), "Never delete the fixtures directory.");
		const agent = buildClaudeMdBlock({ contextFiles: discoverContextFiles({ cwd: repo, homeClaudeDir: join(home, ".claude"), rule: instructionRule(home), home }) }) ?? "";
		expect(agent).toContain("Never delete the fixtures directory.");
		expect(loadProjectInstructions(repo, home)).toContain("Never delete the fixtures directory.");
	});

	it("shows every path-conditional rule, labelled with its paths", () => {
		mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
		writeFileSync(join(repo, ".claude", "rules", "db.md"), "---\npaths: src/db/**\n---\nNever run migrations against production.");
		const loaded = loadProjectInstructions(repo, home) ?? "";
		expect(loaded).toContain("Never run migrations against production.");
		expect(loaded).toContain("(applies to src/db)");
	});

	it("reads no .claude location in independent mode", () => {
		mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
		writeFileSync(join(repo, ".claude", "CLAUDE.md"), "dot claude rule");
		writeFileSync(join(repo, ".claude", "rules", "x.md"), "rules dir rule");
		writeFileSync(join(repo, "AGENTS.md"), "agents rule");
		resetConfigModeForTest("independent");
		const text = loadProjectInstructions(repo, home) ?? "";
		expect(text).toContain("agents rule");
		expect(text).not.toContain("dot claude rule");
		expect(text).not.toContain("rules dir rule");
	});
});
