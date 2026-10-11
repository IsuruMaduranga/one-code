/**
 * Claude Code's auto-mode note (pure): the part of its mid-conversation system
 * message that tells a model in auto mode to work through the shell. Fable gets
 * the firmer wording, every other model the Opus one; tool names are One Code's.
 * It rides only that system message (`systemRoleOnly`), never a user message,
 * and only when the conversation opens in auto mode: the permission-mode
 * reminder carries every later change (decisions/tools.md).
 *
 * Only on the tiers that take Claude Code's fast paths (frontier and
 * workhorse). Claude Code has no auto mode below its Sonnet class, the cheap
 * and tiny tool texts tell the model to read with the read tool, and their
 * stricter gate screens shell edits, so the note there contradicted the tool
 * texts and steered weak models into more classifier calls.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { claudeFamily, usesClaudeCodeFastPaths } from "../lib/model-tier.ts";

const OPUS_NOTE =
	"While auto mode is active:\n\n" +
	"You can do much of your work through the bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated read, edit, or write tools. " +
	"The choice is yours: prefer edit or write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.";

const FABLE_NOTE =
	"While auto mode is active:\n\n" +
	"Do your work through the bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated read, edit, or write tools. " +
	"Fall back to a dedicated tool only when bash genuinely cannot do the job.";

/** The note for a session opening in auto mode on `model`, or undefined on a cheap or tiny model. */
export function autoModeSystemNote(model: Model<Api>): string | undefined {
	if (!usesClaudeCodeFastPaths(model)) return undefined;
	return claudeFamily(model.id) === "fable" ? FABLE_NOTE : OPUS_NOTE;
}
