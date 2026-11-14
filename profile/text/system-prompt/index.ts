/**
 * One Code's system prompt (the profile's `text.systemPrompt`): Claude Code's
 * registers, adapted for One Code, selected by model tier. The base places
 * the computed blocks around and inside these sections
 * (extensions/request/system-prompt/template.ts).
 */

import type { LiveTools, PromptTier, SystemPromptText } from "../../../extensions/sdk/profile.ts";
import type { PromptBundle } from "./common.ts";
import { frontierBundle } from "./frontier.ts";
import { lowBundle } from "./low.ts";
import { memoryPromptSection } from "./memory.ts";
import { midBundle } from "./mid.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";
import { TYPED_SKILL_BULLET } from "./common.ts";
import { DELEGATE_STRICT } from "./low.ts";
import { DELEGATING_WORK, FORK_BULLET } from "./mid.ts";

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

/**
 * The tiny tier's steer to the grep, find and ls tools, and what it says with
 * any of them off: search in the shell. After Agent's, which cuts the whole
 * delegation section the second passage sits in.
 */
const SHELL_SEARCH = [
	[
		", and the grep, find and ls tools to search for files or content (not the find/grep/ls commands in the shell). Reserve the shell for commands that genuinely need it.",
		". Search for files or content in the shell (grep, find, ls). Otherwise reserve the shell for commands that genuinely need it.",
	],
	["use the search tools directly.", "search directly in the shell (grep, find)."],
] as const;

/** Per tool, the passages of the prompt that name it, cut when it is off. */
const PROMPT_PASSAGES: ToolPassages = {
	// Before edit: its passages are matched as written, with edit still named.
	bash: [" - Prefer dedicated tools over bash when one fits (read, edit, write) — reserve bash for shell-only operations.\n", ["; to run something, call the bash tool", ""]],
	skill: [`\n${TYPED_SKILL_BULLET}`, "\n - When a skill fits the task, use it — invoke it with the skill tool instead of redoing the same work by hand. Skills are set up on purpose; reach for the matching one rather than improvising."],
	Agent: [DELEGATING_WORK, DELEGATE_STRICT, `\n${FORK_BULLET}`],
	grep: SHELL_SEARCH,
	find: SHELL_SEARCH,
	ls: SHELL_SEARCH,
	edit: [["(read, edit, write)", "(read, write)"], ["call the edit or write tool", "call the write tool"], [" edit to change them (not sed/awk),", ""], ["the edit/write tools", "the write tool"]],
};

/** The sections without the passages of tools that are off; a section left empty is dropped. */
const liveSections = (sections: readonly string[], live: LiveTools): string[] =>
	sections.map((section) => withoutOff(section, live, PROMPT_PASSAGES)).filter((section) => section.trim() !== "");

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const systemPromptText = (live: LiveTools): SystemPromptText => ({
	lead({ tier, taskTools, tools }) {
		const bundle = BUNDLES[tier];
		return liveSections(bundle.leadFor?.({ taskTools, tools }) ?? (taskTools ? bundle.lead : (bundle.leadWithoutTaskTools ?? bundle.lead)), live);
	},
	tail: ({ tier }) => liveSections(BUNDLES[tier].tail, live),
	// Workhorse, cheap and tiny use the long memory spec.
	memory: (dir, { tier }) => memoryPromptSection(dir, BUNDLES[tier].verboseMemory),
});
