/**
 * Claude Code's auto-mode note (pure): the part of its mid-conversation system
 * message that tells a model in auto mode to work through the shell. Fable gets
 * the firmer wording, every other model the Opus one; tool names are One Code's.
 * It rides only that system message (`systemRoleOnly`), never a user message,
 * and only when the conversation opens in auto mode: the permission-mode
 * reminder carries every later change (decisions/tools.md).
 */

import { claudeFamily } from "../lib/model-tier.ts";

const OPUS_NOTE =
	"While auto mode is active:\n\n" +
	"You can do much of your work through the bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated read, edit, or write tools. " +
	"The choice is yours: prefer edit or write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.";

const FABLE_NOTE =
	"While auto mode is active:\n\n" +
	"Do your work through the bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated read, edit, or write tools. " +
	"Fall back to a dedicated tool only when bash genuinely cannot do the job.";

export function autoModeSystemNote(modelId: string): string {
	return claudeFamily(modelId) === "fable" ? FABLE_NOTE : OPUS_NOTE;
}
