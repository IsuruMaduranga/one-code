/**
 * Claude Code system prompt, adapted for One Code, selected by model tier.
 *
 * The tier-specific section text lives in `tiers/` (one bundle per tier);
 * this module is the tier-agnostic composer — it places the dynamic blocks
 * (tools, memory, the cwd trailer, the budget line) around the bundle's
 * `lead`/`tail` sections. Sections tied to Anthropic-hosted features are
 * dropped. The environment block, the model line and the git snapshot are not
 * here: they ride the first-message context (lib/environment-block.ts,
 * lib/claude-context.ts), or the mid-conversation system message on a model
 * that takes one, as in Claude Code.
 *
 * For a fixed tier this function must be pure and deterministic: same inputs,
 * byte-identical output (prompt-cache stability).
 */

import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { memoryPromptSection } from "../lib/memory.ts";
import type { PromptTier } from "../lib/model-tier.ts";
import type { EnvironmentInfo } from "./environment.ts";
import type { PromptBundle } from "./tiers/common.ts";
import { frontierBundle } from "./tiers/frontier.ts";
import { lowBundle } from "./tiers/low.ts";
import { midBundle } from "./tiers/mid.ts";

/**
 * Four tiers, three register texts. `workhorse` and `cheap` share Claude Code's
 * long register (`midBundle`), as Claude Code sends one text to Haiku 4.5,
 * Sonnet 4.x and Opus 4.5 to 4.7; the two tiers differ in their tool
 * descriptions. `tiny` = the long register plus the weak-model scaffolding
 * (`lowBundle`). See `working-docs/decisions/model-tiers.md`.
 */
const BUNDLES: Record<PromptTier, PromptBundle> = {
	frontier: frontierBundle,
	workhorse: midBundle,
	cheap: midBundle,
	tiny: lowBundle,
};

function buildToolsSection(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const visible = tools.filter((name) => !!options.toolSnippets?.[name]);
	const toolsList =
		visible.length > 0 ? visible.map((name) => `- ${name}: ${options.toolSnippets![name]}`).join("\n") : "(none)";

	const guidelines: string[] = [];
	const seen = new Set<string>();
	for (const g of options.promptGuidelines ?? []) {
		const trimmed = g.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			guidelines.push(trimmed);
		}
	}
	const guidelinesBlock = guidelines.length > 0 ? `\n\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}` : "";

	return `# Available tools\n${toolsList}${guidelinesBlock}`;
}

export function buildClaudeCodeSystemPrompt(
	options: BuildSystemPromptOptions,
	env: Pick<EnvironmentInfo, "cwd" | "memoryDir">,
	tier: PromptTier,
	/**
	 * Claude Code's per-turn budget line (`<total_tokens>N tokens left</total_tokens>`,
	 * `context-budget/budget.ts`), placed last, after the cwd line. Constant for
	 * the session, so it stays cache-stable.
	 */
	totalTokensLine?: string | null,
	/** False when the session model runs without the task tools (`lib/model-tier.ts taskToolsEnabled`). */
	taskTools = true,
): string {
	const bundle = BUNDLES[tier];
	const lead = taskTools ? bundle.lead : (bundle.leadWithoutTaskTools ?? bundle.lead);
	const sections = [
		...lead,
		buildToolsSection(options),
		// Claude Code orders Memory just before Environment; workhorse/cheap/tiny use the long spec.
		memoryPromptSection(env.memoryDir, bundle.verboseMemory),
		...bundle.tail,
	];

	let prompt = sections.join("\n\n");

	// Mirror pi's own custom-prompt assembly: append text, skills, and the
	// trailing cwd line. CLAUDE.md / AGENTS.md context files are NOT put here —
	// Claude Code injects them as the `# claudeMd` <system-reminder> on the first
	// user message (extensions/claude-context), not in the system prompt.
	if (options.appendSystemPrompt) {
		prompt += `\n\n${options.appendSystemPrompt}`;
	}

	// Skills are NOT listed here — the skill extension emits them as the
	// "available for use with the Skill tool" <system-reminder> on the first user
	// message (Claude Code's block 3), framed for the `skill` tool rather than pi's
	// read-the-file convention.

	prompt += `\nCurrent working directory: ${env.cwd.replace(/\\/g, "/")}`;

	// Claude Code ends its prompt with the budget line, after a blank line.
	if (totalTokensLine) {
		prompt += `\n\n${totalTokensLine}`;
	}

	return prompt;
}
