import { describe, expect, it } from "vitest";
import type { PromptTier } from "../../extensions/lib/model-tier.ts";
import type { EnvironmentInfo } from "../../extensions/system-prompt/environment.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/system-prompt/template.ts";

const env: EnvironmentInfo = {
	cwd: "/tmp/project",
	isGitRepo: true,
	platform: "darwin",
	osVersion: "Darwin 24.2.0",
	shell: "zsh",
	memoryDir: "/home/u/.claude/projects/-tmp-project/memory",
};

const baseOptions = { cwd: "/tmp/project" };
const TIERS: PromptTier[] = ["frontier", "workhorse", "cheap", "tiny"];

describe("buildClaudeCodeSystemPrompt", () => {
	it("contains the adapted identity and core sections", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("You are One Code");
		expect(prompt).toContain("# Harness");
		expect(prompt).toContain("<system-reminder>");
		expect(prompt).toContain("# Delivering work");
		expect(prompt).toContain("# Corrections");
		expect(prompt).toContain("Current working directory: /tmp/project");
	});

	it("leaves the environment, model line, scratchpad and git snapshot to the first-message context", () => {
		for (const tier of TIERS) {
			const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			expect(prompt, tier).not.toContain("Primary working directory");
			expect(prompt, tier).not.toContain("You are powered by the model");
			expect(prompt, tier).not.toContain("# Scratchpad Directory");
			expect(prompt, tier).not.toContain("gitStatus");
		}
	});

	it("includes the memory section", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("/home/u/.claude/projects/-tmp-project/memory/");
	});

	it("lists tools that have snippets and appends guidelines", () => {
		const prompt = buildClaudeCodeSystemPrompt(
			{
				...baseOptions,
				selectedTools: ["read", "bash", "secret"],
				toolSnippets: { read: "Read files", bash: "Run commands" },
				promptGuidelines: ["Use read before edit", "Use read before edit", "  "],
			},
			env,
			"frontier",
		);
		expect(prompt).toContain("- read: Read files");
		expect(prompt).toContain("- bash: Run commands");
		expect(prompt).not.toContain("- secret");
		// deduped + trimmed guidelines
		expect(prompt.match(/Use read before edit/g)).toHaveLength(1);
	});

	it("does NOT put project context files in the system prompt", () => {
		// Claude Code injects CLAUDE.md as the `# claudeMd` <system-reminder> on the
		// first user message (extensions/claude-context), never in the system prompt.
		const prompt = buildClaudeCodeSystemPrompt(
			{ ...baseOptions, contextFiles: [{ path: "/tmp/project/CLAUDE.md", content: "Always use tabs." }] },
			env,
			"frontier",
		);
		expect(prompt).not.toContain("<project_instructions");
		expect(prompt).not.toContain("<project_context");
		expect(prompt).not.toContain("Always use tabs.");
	});

	it("keeps the frontier prompt lean (no verbose scaffolding, compact memory)", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("<system-reminder>"); // core explanation stays in all tiers
		expect(prompt).not.toContain("# Doing tasks");
		expect(prompt).not.toContain("# Text output");
		expect(prompt).not.toContain("## Types of memory");
		expect(prompt).not.toContain("bear no direct relation"); // caveat is workhorse/cheap/tiny only
	});

	it("gives workhorse the verbose register and the long memory spec", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "workhorse");
		expect(prompt).toContain("# Doing tasks");
		expect(prompt).toContain("# Executing actions with care");
		expect(prompt).toContain("# Tone and style");
		expect(prompt).toContain("## Types of memory"); // verbose memory
		expect(prompt).toContain("bear no direct relation"); // fuller system-reminder caveat
		expect(prompt).not.toContain("the search tools"); // no dedicated search tools above tiny
	});

	it("shares the verbose register between workhorse and cheap (CC's Sonnet≈Haiku)", () => {
		const workhorse = buildClaudeCodeSystemPrompt(baseOptions, env, "workhorse");
		const cheap = buildClaudeCodeSystemPrompt(baseOptions, env, "cheap");
		expect(cheap).toBe(workhorse);
	});

	it("gives tiny the bespoke weak-model scaffolding, including an explicit skill nudge", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "tiny");
		expect(prompt).toContain("# Make changes with tools, not prose");
		expect(prompt).toContain("# Answer or act");
		expect(prompt).toContain("# Playbooks");
		expect(prompt).toContain("skill tool"); // the skills nudge that motivated tiering
		expect(prompt).toContain("the search tools"); // tiny keeps the grep/find/ls steer
	});

	it("is byte-stable across calls with identical inputs, for each tier", () => {
		for (const tier of TIERS) {
			const a = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			const b = buildClaudeCodeSystemPrompt({ ...baseOptions }, { ...env }, tier);
			expect(a).toBe(b);
		}
	});

	it("produces three distinct registers (frontier, verbose, tiny); workhorse and cheap share one", () => {
		const outputs = TIERS.map((tier) => buildClaudeCodeSystemPrompt(baseOptions, env, tier));
		expect(new Set(outputs).size).toBe(3);
	});


});

describe("the per-turn budget line", () => {
	it("closes the prompt after the cwd line, and is absent when not given", () => {
		const line = "<total_tokens>15000000 tokens left</total_tokens>";
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", line).endsWith(`Current working directory: /tmp/project\n\n${line}`)).toBe(true);
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", null).endsWith("Current working directory: /tmp/project")).toBe(true);
	});

	it("drops the task_create line when the model runs without the task tools", () => {
		for (const tier of ["workhorse", "cheap", "tiny"] as const) {
			const withTasks = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			const without = buildClaudeCodeSystemPrompt(baseOptions, env, tier, null, false);
			expect(withTasks, tier).toContain("task_create");
			expect(without, tier).not.toContain("task_create");
			// Only the task bullets go (tiny carries two); the rest stays.
			expect(withTasks.split("\n").length - without.split("\n").length, tier).toBe(tier === "tiny" ? 2 : 1);
		}
		// Frontier has no task line either way.
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", null, false)).toBe(
			buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", null, true),
		);
	});
});
