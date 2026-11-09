/**
 * One Code's system prompt as its profile words it: the identity line, the
 * three registers by tier (frontier's short one, the long one workhorse and
 * cheap share, tiny's scaffolding), and the task line. Where the base places
 * the text is tested in test/unit/template.test.ts.
 */
import { describe, expect, it } from "vitest";
import { PROMPT_TIERS, type PromptTier } from "../../extensions/lib/models/model-tier.ts";
import type { EnvironmentInfo } from "../../extensions/request/system-prompt/environment.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/request/system-prompt/template.ts";

const env: EnvironmentInfo = {
	cwd: "/tmp/project",
	isGitRepo: true,
	platform: "darwin",
	osVersion: "Darwin 24.2.0",
	shell: "zsh",
	memoryDir: "/home/u/.claude/projects/-tmp-project/memory",
};

const baseOptions = { cwd: "/tmp/project" };

describe("One Code's system prompt", () => {
	it("contains the adapted identity and core sections", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain("You are One Code");
		expect(prompt).not.toContain("You are Claude Code");
		expect(prompt).toContain("# Harness");
		expect(prompt).toContain("<system-reminder>");
		expect(prompt).toContain("Current working directory: /tmp/project");
	});

	it("gives frontier Claude Code's short register, in its order, without Delivering work or Corrections", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		const order = [
			"You are One Code",
			"You are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized security testing",
			"# Harness\n",
			"Write code that reads like the surrounding code",
			"# Session-specific guidance\n",
			"# Available tools\n",
			"# Memory\n",
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

	it("leaves the environment, model line, scratchpad and git snapshot to the first-message context", () => {
		for (const tier of PROMPT_TIERS) {
			const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			expect(prompt, tier).not.toContain("Primary working directory");
			expect(prompt, tier).not.toContain("You are powered by the model");
			expect(prompt, tier).not.toContain("# Scratchpad Directory");
			expect(prompt, tier).not.toContain("gitStatus");
		}
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
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "workhorse");
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
		expect(prompt).toContain("the grep, find and ls tools"); // tiny keeps the grep/find/ls steer, by tool name
		expect(prompt).toContain("to run something, call the bash tool.");
		expect(prompt).not.toContain("a consistency audit"); // the explore agent's description rules audits out
		// Built on the long register: its sections stay, with one "# Using your tools" (tiny's).
		for (const section of ["# System\n", "# Doing tasks\n", "# Executing actions with care\n", "# Text output", "# auto memory\n"]) {
			expect(prompt, section).toContain(section);
		}
		expect(prompt.match(/^# Using your tools$/gm)).toHaveLength(1);
		expect(prompt).not.toContain("# Delegating to agents"); // tiny has its stricter DELEGATE_STRICT
		expect(prompt).not.toContain("# Delivering work");
		expect(prompt).not.toContain("# Corrections");
	});

	it("names tiny's shell tool from the session's tools", () => {
		const call = (selectedTools: string[]) => buildClaudeCodeSystemPrompt({ ...baseOptions, selectedTools }, env, "tiny");
		expect(call(["read", "bash", "edit", "write"])).toContain("to run something, call the bash tool.");
		expect(call(["read", "powershell", "edit", "write"])).toContain("to run something, call the powershell tool.");
		expect(call(["read", "bash", "powershell", "edit", "write"])).toContain("to run something, call the bash or powershell tool.");
		expect(buildClaudeCodeSystemPrompt({ ...baseOptions, selectedTools: ["read", "powershell"] }, env, "tiny", null, false)).toContain("call the powershell tool.");
	});

	it("produces three distinct registers (frontier, verbose, tiny); workhorse and cheap share one", () => {
		const outputs = PROMPT_TIERS.map((tier) => buildClaudeCodeSystemPrompt(baseOptions, env, tier));
		expect(new Set(outputs).size).toBe(3);
	});

	it("includes the memory section and the cwd line", () => {
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier")).toContain("/home/u/.claude/projects/-tmp-project/memory/");
		for (const tier of PROMPT_TIERS) {
			const prompt = buildClaudeCodeSystemPrompt(baseOptions, { ...env, memoryDir: undefined }, tier);
			expect(prompt, tier).not.toMatch(/^# (auto memory|Memory)$/m);
			expect(prompt, tier).toContain("Current working directory: /tmp/project");
		}
	});
});

describe("One Code's task line", () => {
	it("drops the task_create line when the model runs without the task tools", () => {
		for (const tier of ["workhorse", "cheap", "tiny"] as const) {
			const withTasks = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			const without = buildClaudeCodeSystemPrompt(baseOptions, env, tier, null, false);
			expect(withTasks, tier).toContain("task_create");
			expect(without, tier).not.toContain("task_create");
			// Only the task bullet goes; the rest stays.
			expect(withTasks.split("\n").length - without.split("\n").length, tier).toBe(1);
		}
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "workhorse")).toContain(
			"\n - Use task_create (deferred — load it with `tool_search select:task_create,task_update`) to plan and track work. Mark each task completed as soon as it's done; don't batch.\n",
		);
		// Frontier has no task line either way.
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", null, false)).toBe(
			buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", null, true),
		);
	});
});
