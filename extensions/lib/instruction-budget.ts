/**
 * The context-window budget for instruction files: the sections of the
 * instructions blocks (a CLAUDE.md-family file, AGENTS.md or ONECODE.md, with
 * any imports it inlines) may together take at most half of the model's context
 * window; past it, the largest are not loaded until the rest fit. A nested
 * instruction file attached on read is judged alone. A skipped file's slot
 * carries a note with its path and size, so the model knows the rules exist
 * and reads the parts it needs, and the user is warned. Instruction files
 * are rendered into message 1 at every epoch, so compaction cannot reclaim their
 * space. Decided in decisions/memory-state.md ("Instruction files may take
 * half the window; past it the largest are skipped"). Pure logic: no pi API use;
 * the token estimate (pi-ai-estimate.ts) reads only pi's version.
 */

import { formatTokens } from "../footer/footer-line.ts";
import { estimateTextTokens } from "./pi-ai-estimate.ts";

/** The share of the context window instruction files may take together. */
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
		`${what} about ${tokens.toLocaleString("en-US")} tokens, and instruction files may take at most half of this model's ` +
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
		`(Not shown: this instruction file is about ${tokens.toLocaleString("en-US")} tokens, and instruction files may take at most half of the session model's ` +
		`${contextWindow.toLocaleString("en-US")}-token context window, so it is left out here as it is for the agent. Leaving it out grants no permission.)`
	);
}

/**
 * The files fitted to the budget: while their total is over the share, the
 * largest is replaced by `note` (its path, descriptor and imports kept), so a
 * file over the share alone always goes first. Between files of one size the
 * earlier goes (a farther or more global file; the later ones are the more
 * specific). Returns the fitted files in their order and the ones replaced, in
 * their order too. No known window, no budget.
 */
export function fitToWindow<T extends { path: string; content: string; imported?: string[] }>(
	files: readonly T[],
	contextWindow: number | undefined,
	note: (tokens: number, contextWindow: number, imported?: readonly string[]) => string = skippedInstructionNote,
): { files: T[]; skipped: SkippedInstruction[] } {
	if (!contextWindow || contextWindow <= 0) return { files: [...files], skipped: [] };
	const limit = contextWindow * INSTRUCTION_WINDOW_SHARE;
	const tokens = files.map((file) => estimateTextTokens(file.content));
	let total = tokens.reduce((sum, n) => sum + n, 0);
	if (total <= limit) return { files: [...files], skipped: [] };
	const skip = new Set<number>();
	// Largest first; Array.prototype.sort is stable, so a tie keeps file order.
	for (const index of tokens.map((_, i) => i).sort((a, b) => tokens[b] - tokens[a])) {
		if (total <= limit) break;
		skip.add(index);
		total -= tokens[index];
	}
	const skipped: SkippedInstruction[] = [];
	const fitted = files.map((file, index) => {
		if (!skip.has(index)) return file;
		skipped.push({ path: file.path, tokens: tokens[index], contextWindow });
		return { ...file, content: note(tokens[index], contextWindow, file.imported) };
	});
	return { files: fitted, skipped };
}

/** The user's warning for a skipped file; `path` is the display path. */
export function skippedInstructionWarning(path: string, file: Pick<SkippedInstruction, "tokens" | "contextWindow">): string {
	return (
		`${path} (~${formatTokens(file.tokens)} tokens) is not loaded: instruction files may take at most half of this model's ` +
		`${formatTokens(file.contextWindow)}-token context window, and it is the largest past that; the model sees its path instead · /memory to trim it`
	);
}

/** The user's notice when a skipped file loads in full again: it fits the window, or the window is unknown. */
export function restoredInstructionNotice(path: string, contextWindow: number | undefined): string {
	return contextWindow
		? `${path} fits this model's ${formatTokens(contextWindow)}-token context window and loads in full again`
		: `${path} loads in full again: this model's context window is unknown`;
}

