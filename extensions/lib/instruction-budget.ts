/**
 * The context-window budget for instruction files: a section of the
 * instructions block (a CLAUDE.md-family file, AGENTS.md or ONECODE.md, with any
 * imports it inlines) or a nested instruction file attached on read, whose
 * estimated tokens exceed half of the model's context window, is not loaded.
 * Its slot carries a note with its path and size, so the model knows the rules
 * exist and reads the parts it needs, and the user is warned. Instruction files
 * are rendered into message 1 at every epoch, so compaction cannot reclaim their
 * space. Decided in decisions/memory-state.md ("An instruction file over half
 * the window is skipped, and both sides are told"). Pure logic: no pi API use;
 * the token estimate (pi-ai-estimate.ts) reads only pi's version.
 */

import { formatTokens } from "../footer/footer-line.ts";
import { estimateTextTokens } from "./pi-ai-estimate.ts";

/** The share of the context window one instruction file may take before it is skipped. */
const INSTRUCTION_WINDOW_SHARE = 0.5;

/** A skipped file: its path, estimated tokens, and the window it was measured against. */
export interface SkippedInstruction {
	path: string;
	tokens: number;
	contextWindow: number;
}

/** The model's note in a skipped file's slot; `imported` names the files inlined into it. */
export function skippedInstructionNote(tokens: number, contextWindow: number, imported: readonly string[] = []): string {
	const what = imported.length > 0 ? `This file and the files it imports (${imported.join(", ")}) are not loaded: together they are` : "This file is not loaded: it is";
	return (
		`${what} about ${tokens.toLocaleString("en-US")} tokens, more than half of this model's ` +
		`${contextWindow.toLocaleString("en-US")}-token context window. Read the parts of it that bear on your task when you need them.\n`
	);
}

/**
 * The auto-mode classifier's note: it cannot read files, so it is told only
 * that the file exists and is left out, and that leaving it out permits
 * nothing (an instruction file may only tighten what is allowed).
 */
export function classifierInstructionNote(tokens: number, contextWindow: number): string {
	return (
		`(Not shown: this instruction file is about ${tokens.toLocaleString("en-US")} tokens, more than half of the session model's ` +
		`${contextWindow.toLocaleString("en-US")}-token context window, so it is left out here as it is for the agent. Leaving it out grants no permission.)`
	);
}

/**
 * The files with each one over the budget replaced by `note` (its path,
 * descriptor and imports kept), the ones replaced, and whether the files that
 * stay loaded together pass the share. Files that each fit are loaded whole
 * even then: which to drop would be a guess. No known window, no budget.
 */
export function fitToWindow<T extends { path: string; content: string; imported?: string[] }>(
	files: readonly T[],
	contextWindow: number | undefined,
	note: (tokens: number, contextWindow: number, imported?: readonly string[]) => string = skippedInstructionNote,
): { files: T[]; skipped: SkippedInstruction[]; overTotal: boolean } {
	if (!contextWindow || contextWindow <= 0) return { files: [...files], skipped: [], overTotal: false };
	const limit = contextWindow * INSTRUCTION_WINDOW_SHARE;
	const skipped: SkippedInstruction[] = [];
	let loaded = 0;
	const fitted = files.map((file) => {
		const tokens = estimateTextTokens(file.content);
		if (tokens <= limit) {
			loaded += tokens;
			return file;
		}
		skipped.push({ path: file.path, tokens, contextWindow });
		return { ...file, content: note(tokens, contextWindow, file.imported) };
	});
	return { files: fitted, skipped, overTotal: loaded > limit };
}

/** The user's warning for a skipped file; `path` is the display path. */
export function skippedInstructionWarning(path: string, file: Pick<SkippedInstruction, "tokens" | "contextWindow">): string {
	return (
		`${path} is ~${formatTokens(file.tokens)} tokens, over half of this model's ${formatTokens(file.contextWindow)}-token context window, ` +
		"so it is not loaded; the model sees its path instead · /memory to trim it"
	);
}

/** The user's notice when a skipped file loads in full again: it fits the window, or the window is unknown. */
export function restoredInstructionNotice(path: string, contextWindow: number | undefined): string {
	return contextWindow
		? `${path} fits this model's ${formatTokens(contextWindow)}-token context window and loads in full again`
		: `${path} loads in full again: this model's context window is unknown`;
}

/** The user's warning when instruction files that each fit together pass the share. */
export function combinedInstructionWarning(contextWindow: number): string {
	return `Instruction files together take over half of this model's ${formatTokens(contextWindow)}-token context window · /memory to trim them`;
}
