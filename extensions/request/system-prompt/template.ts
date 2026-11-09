/**
 * The system prompt composer: the profile's sections (`text.systemPrompt`,
 * working-docs/features/profiles/) with the computed blocks placed between
 * them: the tool list, the memory section, sections other extensions add
 * (SYSTEM_PROMPT_SECTION_CHANNEL, text.ts), appended text, the working
 * directory and the budget line. The environment block, the model line and
 * the git snapshot are not here: they ride the first-message context
 * (lib/context/environment-block.ts, context/claude-context/claude-context.ts), or the mid-conversation
 * system message on a model that takes one, as in Claude Code.
 *
 * For a fixed tier this function must be pure and deterministic: same inputs,
 * byte-identical output (prompt-cache stability).
 */

import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { PromptTier } from "../../lib/models/model-tier.ts";
import { profileText } from "../../lib/profile/profile.ts";
import type { EnvironmentInfo } from "./environment.ts";
import type { SystemPromptSection, SystemPromptSession } from "./text.ts";

/** The active tools with a snippet, in registration order, and the tools' guidelines, deduplicated. */
function toolListInputs(options: BuildSystemPromptOptions): { tools: { name: string; snippet: string }[]; guidelines: string[] } {
	const selected = options.selectedTools ?? ["read", "bash", "edit", "write"];
	// In registration order (the snippets' own), never activation order: a tool
	// withdrawn and brought back (a model hop through another tier) is appended
	// to pi's active list, and a prompt built from that order would depend on
	// the process's history instead of the branch (R3, the fresh-process oracle).
	const order = Object.keys(options.toolSnippets ?? {});
	const rank = (name: string) => {
		const at = order.indexOf(name);
		return at === -1 ? order.length : at;
	};
	const tools = selected
		.filter((name) => !!options.toolSnippets?.[name])
		.sort((a, b) => rank(a) - rank(b))
		.map((name) => ({ name, snippet: options.toolSnippets![name] }));
	const guidelines: string[] = [];
	const seen = new Set<string>();
	for (const g of options.promptGuidelines ?? []) {
		const trimmed = g.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			guidelines.push(trimmed);
		}
	}
	return { tools, guidelines };
}

export function buildClaudeCodeSystemPrompt(
	options: BuildSystemPromptOptions,
	env: Pick<EnvironmentInfo, "cwd" | "memoryDir">,
	tier: PromptTier,
	/**
	 * Claude Code's per-turn budget line (`<total_tokens>N tokens left</total_tokens>`,
	 * `lib/context/budget.ts`, worded by `text.contextBudget`), placed last, after the cwd line. Constant for
	 * the session, so it stays cache-stable.
	 */
	totalTokensLine?: string | null,
	/** False when the session model runs without the task tools (`lib/models/model-tier.ts taskToolsEnabled`). */
	taskTools = true,
	/** Sections other extensions announced, in announcement order. */
	extraSections: readonly SystemPromptSection[] = [],
): string {
	const text = profileText().systemPrompt;
	const session: SystemPromptSession = { tier, taskTools, tools: options.selectedTools };
	const extra = (place: SystemPromptSection["place"]) =>
		extraSections.filter((section) => section.place === place).flatMap((section) => section.render(session) ?? []);
	const { tools, guidelines } = toolListInputs(options);
	const sections = [
		...text.lead(session),
		...extra("lead"),
		text.toolList(tools, guidelines),
		// No section while auto-memory is off, as in Claude Code.
		...(env.memoryDir ? [text.memory(env.memoryDir, session)] : []),
		...text.tail(session),
		...extra("tail"),
	];

	let prompt = sections.join("\n\n");

	// Mirror pi's own custom-prompt assembly: append text, skills, and the
	// trailing cwd line. CLAUDE.md / AGENTS.md context files are NOT put here —
	// Claude Code sends them as the instructions <system-reminder> on the first
	// user message (extensions/claude-context), not in the system prompt.
	if (options.appendSystemPrompt) {
		prompt += `\n\n${options.appendSystemPrompt}`;
	}

	// Skills are NOT listed here — the skill extension emits them as the
	// "available for use with the Skill tool" <system-reminder> on the first user
	// message (Claude Code's block 3), framed for the `skill` tool rather than pi's
	// read-the-file convention.

	prompt += `\n${text.cwdLine(env.cwd.replace(/\\/g, "/"))}`;

	// Claude Code ends its prompt with the budget line, after a blank line.
	if (totalTokensLine) {
		prompt += `\n\n${totalTokensLine}`;
	}

	return prompt;
}
