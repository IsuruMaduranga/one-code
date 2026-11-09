import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { profile } from "../index.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectInstructions } from "../../extensions/permissions/auto-mode/instructions.ts";
import { buildClaudeMdBlock } from "../../extensions/claude-context/claude-context.ts";
import { discoverContextFiles } from "../claude-code/instructions.ts";
import { readInstructionFiles } from "../claude-code/settings.ts";
import { resetConfigModeForTest } from "../claude-code/mode.ts";
import { classifierInstructionNote, skippedInstructionNote } from "../../extensions/lib/context/instruction-budget.ts";
import { estimateTextTokens } from "../../extensions/lib/models/pi-ai-estimate.ts";

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
		expect(loadProjectInstructions(repo, home, undefined, undefined)).toBeUndefined();
	});

	it("returns undefined while the agent's instruction files are off, as the agent then reads none", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "claude rule");
		writeFileSync(join(repo, "AGENTS.md"), "never push to main");
		setActiveProfileForTest(resolveProfile(profile, { ONECODE_FEATURES_OFF: "claude-context" }, "/profile"));
		try {
			expect(loadProjectInstructions(repo, home, undefined, undefined)).toBeUndefined();
		} finally {
			setActiveProfileForTest(undefined);
		}
		expect(loadProjectInstructions(repo, home, undefined, undefined)).toContain("claude rule");
	});

	it("reads AGENTS.md beside CLAUDE.md in compatible mode, whatever instructionFiles picks for the agent", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "claude rule");
		writeFileSync(join(repo, "AGENTS.md"), "never push to main");
		const text = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
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
				const text = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
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
		const text = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
		expect(text).toContain("agents rule");
		expect(text).not.toContain("claude rule");
		expect(text).not.toContain("global rule");
	});

	it("reads CLAUDE.md from the working directory", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "Never force push.");
		const loaded = loadProjectInstructions(repo, home, undefined, undefined);
		expect(loaded).toContain("Never force push.");
		expect(loaded).toContain("CLAUDE.md");
	});

	it("walks up every ancestor in the agent's order, farthest first", () => {
		writeFileSync(join(repo, "CLAUDE.md"), "ROOT RULE");
		writeFileSync(join(nested, "CLAUDE.md"), "NESTED RULE");
		const loaded = loadProjectInstructions(nested, home, undefined, undefined) ?? "";
		expect(loaded.indexOf("ROOT RULE")).toBeLessThan(loaded.indexOf("NESTED RULE"));
	});

	it("reads an ancestor above the git root, as the agent does", () => {
		writeFileSync(join(root, "CLAUDE.md"), "OUTSIDE REPO");
		writeFileSync(join(repo, "CLAUDE.md"), "IN REPO");
		const loaded = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
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
		const loaded = loadProjectInstructions(nested, home, undefined, undefined) ?? "";
		expect(loaded).toContain("Never run migrations against production.");
		expect(loaded).toContain(global);
		expect(loaded).toContain(`ROOT ${"r".repeat(200_000)} END ROOT`);
		expect(loaded).toContain("NESTED: never run migrations.");
	});

	it("includes AGENTS.md and the user's global file", () => {
		writeFileSync(join(repo, "AGENTS.md"), "AGENTS CONTENT");
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "GLOBAL CONTENT");
		const loaded = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
		expect(loaded).toContain("AGENTS CONTENT");
		expect(loaded).toContain("GLOBAL CONTENT");
	});

	// The agent loads these (claude-context/claude-context.ts); the classifier must see the same restriction.
	it.each([
		[".claude/CLAUDE.md", join(".claude", "CLAUDE.md")],
		["an unconditional .claude/rules file", join(".claude", "rules", "safety.md")],
	])("carries a restriction in %s to both the agent and the classifier", (_label, relative) => {
		mkdirSync(join(repo, relative, ".."), { recursive: true });
		writeFileSync(join(repo, relative), "Never delete the fixtures directory.");
		const agent = buildClaudeMdBlock({ contextFiles: discoverContextFiles({ cwd: repo, homeClaudeDir: join(home, ".claude"), rule: readInstructionFiles(home), home }) }) ?? "";
		expect(agent).toContain("Never delete the fixtures directory.");
		expect(loadProjectInstructions(repo, home, undefined, undefined)).toContain("Never delete the fixtures directory.");
	});

	it("shows every path-conditional rule, labelled with its paths", () => {
		mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
		writeFileSync(join(repo, ".claude", "rules", "db.md"), "---\npaths: src/db/**\n---\nNever run migrations against production.");
		const loaded = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
		expect(loaded).toContain("Never run migrations against production.");
		expect(loaded).toContain("(applies to src/db)");
	});

	it("reads no .claude location in independent mode", () => {
		mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
		writeFileSync(join(repo, ".claude", "CLAUDE.md"), "dot claude rule");
		writeFileSync(join(repo, ".claude", "rules", "x.md"), "rules dir rule");
		writeFileSync(join(repo, "AGENTS.md"), "agents rule");
		resetConfigModeForTest("independent");
		const text = loadProjectInstructions(repo, home, undefined, undefined) ?? "";
		expect(text).toContain("agents rule");
		expect(text).not.toContain("dot claude rule");
		expect(text).not.toContain("rules dir rule");
	});

	describe("the session model's window", () => {
		/** 24,000 characters, and pi-ai's estimate for them (its chars-per-token depends on pi's version). */
		const BIG = "x".repeat(24_000);
		const T = estimateTextTokens(BIG);

		it("replaces a file over half the window with a note in its labelled slot, never a cut", () => {
			writeFileSync(join(repo, "CLAUDE.md"), `never force push\n${BIG}`);
			writeFileSync(join(repo, "AGENTS.md"), "never push to main");
			const text = loadProjectInstructions(repo, home, T, undefined) ?? "";
			const tokens = estimateTextTokens(`never force push\n${BIG}`);
			expect(text).toContain(`# ${join(repo, "CLAUDE.md")}\n${classifierInstructionNote(tokens, T)}`);
			expect(text).not.toContain("never force push");
			expect(text).not.toContain("xxxx");
			expect(text).toContain("never push to main");
			expect(classifierInstructionNote(tokens, T)).toContain("Leaving it out grants no permission.");
		});

		it("leaves out exactly the files the agent leaves out: the largest past half the window", () => {
			writeFileSync(join(repo, "CLAUDE.md"), `claude ${BIG}`);
			writeFileSync(join(repo, "CLAUDE.local.md"), `local ${BIG} and more`);
			// Room for the first file and the note in the second's slot, not for both files.
			const window = 2 * estimateTextTokens(`claude ${BIG}`) + 400;
			const text = loadProjectInstructions(repo, home, window, undefined) ?? "";
			expect(text).toContain(`claude ${BIG}`);
			expect(text).toContain(`# ${join(repo, "CLAUDE.local.md")}\n${classifierInstructionNote(estimateTextTokens(`local ${BIG} and more`), window)}`);
			const agent = discoverContextFiles({ cwd: repo, homeClaudeDir: join(home, ".claude"), rule: readInstructionFiles(home), home });
			expect(agent.map((file) => file.path)).toEqual([join(repo, "CLAUDE.md"), join(repo, "CLAUDE.local.md")]);
		});

		it("counts a skipped agent file by the note this prompt renders for it", () => {
			writeFileSync(join(repo, "CLAUDE.md"), `claude ${BIG}`);
			const window = T; // the agent's file alone is over half
			const agentTokens = estimateTextTokens(`claude ${BIG}`);
			const classifierNote = estimateTextTokens(classifierInstructionNote(agentTokens, window));
			const agentNote = estimateTextTokens(skippedInstructionNote(agentTokens, window));
			expect(agentNote).toBeLessThan(classifierNote);
			// A rule that fits beside the agent's shorter note, not beside the classifier's.
			const target = Math.floor(window / 2) - classifierNote + 1;
			let body = "RULE-A ";
			while (estimateTextTokens(body) < target) body += "z";
			expect(agentNote + estimateTextTokens(body)).toBeLessThanOrEqual(window / 2);
			mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
			writeFileSync(join(repo, ".claude", "rules", "a.md"), `---\npaths: ["a/**"]\n---\n${body}`);
			const text = loadProjectInstructions(repo, home, window, undefined) ?? "";
			expect(text).not.toContain("RULE-A");
			expect(text).toContain("a.md (applies to a)\n(Not shown:");
		});

		it("fits the files only the classifier reads together, within what the agent's files leave", () => {
			writeFileSync(join(repo, "CLAUDE.md"), "claude rule");
			mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
			// Two path-conditional rules, each under half the window, together over it.
			writeFileSync(join(repo, ".claude", "rules", "a.md"), `---\npaths: ["a/**"]\n---\nRULE-A ${BIG}`);
			writeFileSync(join(repo, ".claude", "rules", "b.md"), `---\npaths: ["b/**"]\n---\nRULE-B ${BIG} and more`);
			const text = loadProjectInstructions(repo, home, Math.ceil(3 * T), undefined) ?? "";
			expect(text).toContain("claude rule");
			expect(text).toContain("RULE-A");
			expect(text).not.toContain("RULE-B");
			expect(text).toContain("b.md (applies to b)\n(Not shown:");
		});

		it("skips a file only the classifier reads when it alone is over the share", () => {
			writeFileSync(join(repo, "CLAUDE.md"), "claude rule");
			mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
			writeFileSync(join(repo, ".claude", "rules", "big.md"), `---\npaths: ["src/**"]\n---\n${BIG}`);
			const text = loadProjectInstructions(repo, home, T, undefined) ?? "";
			expect(text).toContain("claude rule");
			expect(text).not.toContain("xxxx");
			expect(text).toContain("big.md (applies to src)\n(Not shown:");
		});

		it("skips nothing without a known window", () => {
			writeFileSync(join(repo, "CLAUDE.md"), BIG);
			expect(loadProjectInstructions(repo, home, undefined, undefined)).toContain(BIG);
			expect(loadProjectInstructions(repo, home, 0, undefined)).toContain(BIG);
		});
	});
});
