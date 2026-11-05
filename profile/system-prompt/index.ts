/**
 * One Code's system prompt (the profile's `text.systemPrompt`): Claude Code's
 * registers, adapted for One Code, selected by model tier. The base places
 * the computed blocks around and inside these sections
 * (extensions/system-prompt/template.ts).
 */

import type { PromptTier } from "../../extensions/lib/model-tier.ts";
import type { SystemPromptText } from "../../extensions/system-prompt/text.ts";
import type { PromptBundle } from "./common.ts";
import { frontierBundle } from "./frontier.ts";
import { lowBundle } from "./low.ts";
import { memoryPromptSection } from "./memory.ts";
import { midBundle } from "./mid.ts";

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

export const systemPrompt: SystemPromptText = {
	lead({ tier, taskTools, tools }) {
		const bundle = BUNDLES[tier];
		return bundle.leadFor?.({ taskTools, tools }) ?? (taskTools ? bundle.lead : (bundle.leadWithoutTaskTools ?? bundle.lead));
	},
	tail: ({ tier }) => BUNDLES[tier].tail,
	// Workhorse, cheap and tiny use the long memory spec.
	memory: (dir, { tier }) => memoryPromptSection(dir, BUNDLES[tier].verboseMemory),
	toolList(tools, guidelines) {
		const list = tools.length > 0 ? tools.map(({ name, snippet }) => `- ${name}: ${snippet}`).join("\n") : "(none)";
		const guidelinesBlock = guidelines.length > 0 ? `\n\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}` : "";
		return `# Available tools\n${list}${guidelinesBlock}`;
	},
	cwdLine: (cwd) => `Current working directory: ${cwd}`,
};
