/**
 * One Code's system prompt (the profile's `text.systemPrompt`): Claude Code's
 * registers, adapted for One Code, selected by model tier. The base places
 * the computed blocks around and inside these sections
 * (extensions/system-prompt/template.ts).
 */

import type { PromptTier } from "../../../extensions/lib/model-tier.ts";
import type { SystemPromptText } from "../../../extensions/system-prompt/text.ts";
import type { PromptBundle } from "./common.ts";
import { frontierBundle } from "./frontier.ts";
import { lowBundle } from "./low.ts";
import { memoryPromptSection } from "./memory.ts";
import { midBundle } from "./mid.ts";
import type { LiveTools } from "../../../extensions/lib/live-tools.ts";
import { type ToolPassages, withoutOff } from "../../live-tools.ts";
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

/** Per tool, the passages of the prompt that name it, cut when it is off. */
const PROMPT_PASSAGES: ToolPassages = {
	skill: [`\n${TYPED_SKILL_BULLET}`, "\n - When a skill fits the task, use it — invoke it with the skill tool instead of redoing the same work by hand. Skills are set up on purpose; reach for the matching one rather than improvising."],
	Agent: [DELEGATING_WORK, DELEGATE_STRICT, `\n${FORK_BULLET}`],
	edit: [["(read, edit, write)", "(read, write)"], ["call the edit or write tool", "call the write tool"], [" edit to change them (not sed/awk),", ""], ["the edit/write tools", "the write tool"]],
};

/** The sections without the passages of tools that are off; a section left empty is dropped. */
const liveSections = (sections: readonly string[], live: LiveTools): string[] =>
	sections.map((section) => withoutOff(section, live, PROMPT_PASSAGES)).filter((section) => section.trim() !== "");

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const systemPromptText = (live: LiveTools): SystemPromptText => ({
	scratchpadMoved: ({ dir }) => `This session's scratchpad directory is now ${dir}. Use it for temporary files instead of the scratchpad named earlier in this conversation.`,
	lead({ tier, taskTools, tools }) {
		const bundle = BUNDLES[tier];
		return liveSections(bundle.leadFor?.({ taskTools, tools }) ?? (taskTools ? bundle.lead : (bundle.leadWithoutTaskTools ?? bundle.lead)), live);
	},
	tail: ({ tier }) => liveSections(BUNDLES[tier].tail, live),
	// Workhorse, cheap and tiny use the long memory spec.
	memory: (dir, { tier }) => memoryPromptSection(dir, BUNDLES[tier].verboseMemory),
	toolList(tools, guidelines) {
		const list = tools.length > 0 ? tools.map(({ name, snippet }) => `- ${name}: ${snippet}`).join("\n") : "(none)";
		const guidelinesBlock = guidelines.length > 0 ? `\n\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}` : "";
		return `# Available tools\n${list}${guidelinesBlock}`;
	},
	cwdLine: (cwd) => `Current working directory: ${cwd}`,
});
