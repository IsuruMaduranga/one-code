/**
 * Claude Code's auto-mode note, worded by the profile (text.ts): the part of its mid-conversation system
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
import { claudeFamily, usesClaudeCodeFastPaths } from "../../lib/models/model-tier.ts";
import { autoModeWords } from "./words.ts";

/** The note for a session opening in auto mode on `model`, or undefined on a cheap or tiny model. */
export function autoModeSystemNote(model: Model<Api>): string | undefined {
	if (!usesClaudeCodeFastPaths(model)) return undefined;
	return autoModeWords().systemNote({ firm: claudeFamily(model.id) === "fable" });
}
