import { describe, expect, it } from "vitest";
import { PROMPT_TIERS, type PromptTier } from "../../extensions/lib/model-tier.ts";
import type { EnvironmentInfo } from "../../extensions/system-prompt/environment.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/system-prompt/template.ts";

/**
 * Where the base places the profile's system-prompt text: the memory section
 * for the session's memory folder, the tool list, the cwd line and the budget
 * line, byte-stable across calls. One Code's own registers and wording are
 * tested in profile/test/template-wording.test.ts.
 */

const env: EnvironmentInfo = {
	cwd: "/tmp/project",
	isGitRepo: true,
	platform: "darwin",
	osVersion: "Darwin 24.2.0",
	shell: "zsh",
	memoryDir: "/home/u/.claude/projects/-tmp-project/memory",
};

const baseOptions = { cwd: "/tmp/project" };
const text = () => requireText("systemPrompt");
/** The session the base builds for these options (no selected tools, task tools on). */
const session = (tier: PromptTier) => ({ tier, taskTools: true, tools: undefined });

describe("buildClaudeCodeSystemPrompt", () => {
	it("includes the memory section for the session's memory folder", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, "frontier");
		expect(prompt).toContain(`\n\n${text().memory(env.memoryDir!, session("frontier"))}\n\n`);
	});

	it.each(PROMPT_TIERS)("drops the memory section while auto-memory is off (%s)", (tier) => {
		const on = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, { ...env, memoryDir: undefined }, tier);
		// Only the memory section goes; the rest stays.
		expect(prompt).toBe(on.replace(`\n\n${text().memory(env.memoryDir!, session(tier))}`, ""));
		expect(prompt).not.toBe(on);
		expect(prompt).toContain(text().cwdLine("/tmp/project"));
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
		// Only tools with a snippet, deduplicated and trimmed guidelines.
		expect(prompt).toContain(
			text().toolList(
				[
					{ name: "read", snippet: "Read files" },
					{ name: "bash", snippet: "Run commands" },
				],
				["Use read before edit"],
			),
		);
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

	it("is byte-stable across calls with identical inputs, for each tier", () => {
		for (const tier of PROMPT_TIERS) {
			const a = buildClaudeCodeSystemPrompt(baseOptions, env, tier);
			const b = buildClaudeCodeSystemPrompt({ ...baseOptions }, { ...env }, tier);
			expect(a).toBe(b);
		}
	});
});

describe("the per-turn budget line", () => {
	it("closes the prompt after the cwd line, and is absent when not given", () => {
		const line = "<total_tokens>15000000 tokens left</total_tokens>";
		const cwdLine = text().cwdLine("/tmp/project");
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", line).endsWith(`\n${cwdLine}\n\n${line}`)).toBe(true);
		expect(buildClaudeCodeSystemPrompt(baseOptions, env, "frontier", null).endsWith(`\n${cwdLine}`)).toBe(true);
	});
});
