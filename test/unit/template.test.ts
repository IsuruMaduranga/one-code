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
	modelLine: "claude-opus-5 (anthropic)",
	memoryDir: "/home/u/.claude/projects/-tmp-project/memory",
};

const baseOptions = { cwd: "/tmp/project" };
const TIERS: PromptTier[] = ["frontier", "workhorse", "cheap", "tiny"];

describe("buildClaudeCodeSystemPrompt", () => {
	it("contains the adapted identity and core sections", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("You are One Code");
		expect(prompt).not.toContain("You are Claude Code");
		expect(prompt).toContain("# Harness");
		expect(prompt).toContain("<system-reminder>");
		expect(prompt).toContain("Current working directory: /tmp/project");
	});

	it("gives frontier Claude Code's short register, in its order, without Delivering work or Corrections", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", "/tmp/scratch");
		const order = [
			"You are One Code",
			"You are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized security testing",
			"# Harness\n",
			"Write code that reads like the surrounding code",
			"# Session-specific guidance\n",
			"# Available tools\n",
			"# Memory\n",
			"# Environment\n",
			"# Scratchpad Directory\n",
			"# Context management\n",
		];
		const at = order.map((s) => prompt.indexOf(s));
		for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThanOrEqual(0);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		// Claude Code's opening line follows the identity line on the next line.
		expect(prompt).toMatch(/^You are One Code[^\n]*\nYou are an agent working with the user/);
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "tiny")).toMatch(/^You are One Code[^\n]*\nYou are an agent working with the user/);
		expect(prompt).toContain("Prefer the dedicated file/search tools over shell commands when one fits.");
		expect(prompt).toContain("suggest they type `! <command>` in the prompt");
		expect(prompt).toContain("When the user types `/<skill-name>`, invoke it via the skill tool.");
		expect(prompt).toContain("give a recommendation, not an exhaustive survey");
		expect(prompt).not.toContain("# Delivering work");
		expect(prompt).not.toContain("# Corrections");
		// Text for features and tools One Code lacks stays out.
		expect(prompt).not.toContain("<pasted_content>");
		expect(prompt).not.toContain("EndConversation");
		expect(prompt).not.toContain("WebSearch takes a `mode`");
	});

	it("renders the environment block", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("Working directory: /tmp/project");
		expect(prompt).toContain("Is a git repository: yes");
		expect(prompt).toContain("Model: claude-opus-5 (anthropic)");
	});

	it("includes the scratchpad section after the environment block, only when a dir exists", () => {
		const scratchpad = "/private/tmp/onecode-501/-tmp-project/abc-123/scratchpad";
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

	it("keeps the frontier prompt lean (no long-register sections, compact memory)", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("<system-reminder>"); // core explanation stays in all tiers
		expect(prompt).not.toContain("# Doing tasks");
		expect(prompt).not.toContain("# Text output");
		expect(prompt).not.toContain("# auto memory");
		expect(prompt).not.toContain("## Types of memory");
		expect(prompt).not.toContain("bear no direct relation"); // caveat is workhorse/cheap/tiny only
	});

	it("gives workhorse Claude Code's long register, in its order, and the long memory spec", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "workhorse", "/tmp/scratch");
		const order = [
			"You are One Code",
			"You are an agent working with the user toward their goals, using your own judgment along the way. Use the instructions below and the tools available to you to assist the user.",
			"defensive use cases.\nIMPORTANT: You must NEVER generate or guess URLs",
			"# System\n",
			"# Doing tasks\n",
			"# Executing actions with care\n",
			"# Using your tools\n",
			"# Delegating to agents\n",
			"# Tone and style\n",
			"# Text output (does not apply to tool calls)\n",
			"# Session-specific guidance\n",
			"# Available tools\n",
			"# auto memory\n",
			"## Types of memory",
			"## What NOT to save in memory",
			"## Memory and other forms of persistence",
			"# Environment\n",
			"# Scratchpad Directory\n",
			"# Context management\n",
		];
		const at = order.map((s) => prompt.indexOf(s));
		for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThanOrEqual(0);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(prompt).toContain("bear no direct relation"); // fuller system-reminder caveat
		expect(prompt).toContain('Calling Agent with subagent_type: "fork" creates a fork');
		expect(prompt).toContain("Prefer dedicated tools over bash when one fits (read, edit, write)");
		expect(prompt).toContain("write to it directly with the write tool");
		expect(prompt).not.toContain("the search tools"); // no dedicated search tools above tiny
		expect(prompt).not.toContain("# Delivering work");
		expect(prompt).not.toContain("# Corrections");
		// Claude Code-only parts of the long register stay out.
		expect(prompt).not.toContain("<pasted_content>");
		expect(prompt).not.toContain("<user-prompt-submit-hook>");
		expect(prompt).not.toContain("/help");
		expect(prompt).not.toContain("Claude Code");
	});

	it("shares the long register between workhorse and cheap", () => {
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
		// Built on the long register: its sections stay, with one "# Using your tools" (tiny's).
		for (const section of ["# System\n", "# Doing tasks\n", "# Executing actions with care\n", "# Text output", "# auto memory\n"]) {
			expect(prompt, section).toContain(section);
		}
		expect(prompt.match(/^# Using your tools$/gm)).toHaveLength(1);
		expect(prompt).not.toContain("# Delegating to agents"); // tiny has its stricter DELEGATE_STRICT
		expect(prompt).not.toContain("# Delivering work");
		expect(prompt).not.toContain("# Corrections");
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

describe("the per-turn budget line", () => {
	it("sits after the cwd line and before the git snapshot, and is absent when not given", () => {
		const line = "<total_tokens>15000000 tokens left</total_tokens>";
		const git = "gitStatus: This is the git status at the start of the conversation.";
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", undefined, git, line);
		expect(prompt.endsWith(`Current working directory: /tmp/project\n\n${line}\n\n${git}`)).toBe(true);
		// No git repo: the line closes the prompt.
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", undefined, null, line).endsWith(`\n\n${line}`)).toBe(true);
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", undefined, git, null).endsWith(`Current working directory: /tmp/project\n\n${git}`)).toBe(true);
	});

	it("drops the task_create line when the model runs without the task tools", () => {
		for (const tier of ["workhorse", "cheap", "tiny"] as const) {
			const withTasks = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			const without = buildClaudeCodeSystemPrompt(baseOptions, env, tier, undefined, null, null, false);
			expect(withTasks, tier).toContain("task_create");
			expect(without, tier).not.toContain("task_create");
			// Only the task bullet goes; the rest stays.
			expect(withTasks.split("\n").length - without.split("\n").length, tier).toBe(1);
		}
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "workhorse")).toContain(
			"\n - Use task_create to plan and track work. Mark each task completed as soon as it's done; don't batch.\n",
		);
		// Frontier has no task line either way.
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", undefined, null, null, false)).toBe(
			buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", undefined, null, null, true),
		);
	});
});
