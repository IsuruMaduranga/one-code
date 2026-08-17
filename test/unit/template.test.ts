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
	date: "2026-08-05",
	modelLine: "claude-opus-5 (anthropic)",
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

	it("renders the environment block", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("Working directory: /tmp/project");
		expect(prompt).toContain("Is a git repository: yes");
		expect(prompt).toContain("Model: claude-opus-5 (anthropic)");
	});

	it("includes the scratchpad section after the environment block, only when a dir exists", () => {
		const scratchpad = "/private/tmp/claude-501/-tmp-project/abc-123/scratchpad";
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", scratchpad);
		expect(prompt).toContain("# Scratchpad Directory");
		expect(prompt).toContain(scratchpad);
		expect(prompt.indexOf("# Environment")).toBeLessThan(prompt.indexOf("# Scratchpad Directory"));
		// An unwritable /tmp drops the section rather than promising a dead dir.
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier")).not.toContain("# Scratchpad Directory");
	});

	it("includes the memory section just before the environment block", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("# Memory");
		expect(prompt).toContain("/home/u/.claude/projects/-tmp-project/memory/");
		expect(prompt.indexOf("# Memory")).toBeLessThan(prompt.indexOf("# Environment"));
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

	it("varying only the model line within a tier changes only the Model line", () => {
		const strip = (s: string) => s.replace(/- Model: .*/, "- Model:");
		for (const tier of TIERS) {
			const a = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			const b = buildClaudeCodeSystemPrompt(baseOptions, { ...env, modelLine: "gpt-5 (openai)" }, tier);
			expect(a).not.toBe(b);
			expect(strip(a)).toBe(strip(b));
		}
	});
});
