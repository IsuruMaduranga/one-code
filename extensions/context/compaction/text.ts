/**
 * The compaction extension's words. The extension decides when and how to
 * compact (the cut, the replay or standalone request, which tool results to
 * clear, the kept tail). The profile words the request and the stored
 * summary (`CompactionText`); the note left in place of a cleared tool
 * result is here (`compactionResultText`). The summarizer's answer is read back by
 * the base (prompt.ts extractSummary), so the instruction must ask for the
 * surviving context inside a `<summary>` block, with any scratch work in an
 * `<analysis>` block.
 */

export type CompactionReason = "manual" | "threshold" | "overflow";

/** How the instruction points at the first message kept verbatim after the summary. */
export type KeptTailLandmark =
	/** A tool result, by the tool that produced it. */
	| { kind: "toolResult"; tool: string }
	/** A message's opening, on one line and clipped by the base. */
	| { kind: "opens"; text: string }
	/** An assistant message with no text, by the tool it calls and what the call is about (clipped). */
	| { kind: "calls"; tool: string; hint?: string };

/** The trailing messages pi keeps verbatim after the cut; a `count` of 0 gets no note. */
export interface KeptTail {
	count: number;
	landmark?: KeptTailLandmark;
}

export interface CompactionText {
	/** The user message appended to the conversation to ask for the summary. */
	instruction(p: { reason: CompactionReason; customInstructions?: string; keptTail?: KeptTail }): string;
	/** The summary as stored and sent from then on; `transcriptPath` is the session file the summary replaced, when there is one. */
	continuation(p: { summary: string; transcriptPath?: string }): string;
	/** The system prompt of a standalone compaction request (no tools, not cache-replayed). */
	standaloneSystemPrompt: string;
}

/** The group's results, refusals and notes, which the base words (`compactionResultText`). */
export interface CompactionResultText {
	/** Stands in for the rest of a tool result cleared to fit a standalone request. */
	clearedResult(p: { omittedChars: number; images: number }): string;
}

/** The base's words of the group. */
export const compactionResultText: CompactionResultText = {
	clearedResult: ({ omittedChars, images }) =>
		`[Tool result cleared to fit the compaction request: ${omittedChars} more characters${
			images > 0 ? ` and ${images} image${images === 1 ? "" : "s"}` : ""
		} omitted. The full result is in the session transcript.]`,
};
