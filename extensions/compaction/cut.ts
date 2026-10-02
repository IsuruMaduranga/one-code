/**
 * Where a compaction cuts the conversation. Pure: no pi extension API.
 *
 * pi keeps the last ~20k tokens verbatim after its summary (`keepRecentTokens`).
 * Claude Code keeps only the final assistant reply (findings §47), and
 * so does One Code: the summary, that reply, then whatever came after it (the
 * results of a tool call it made, on an overflow mid-turn). A short kept tail
 * also keeps little signed thinking across the boundary (findings §46).
 *
 * pi's own cut is moved to the last assistant message that reaches the
 * provider. When pi cut earlier (a keep window above 0), the messages between
 * the two cuts join the doomed span. When pi cut later (with the window at 0,
 * pi cuts at the last cut point, which can be a queued prompt or a harness
 * notification that arrived after the reply), the reply and what follows it
 * leave the doomed span, so the summary does not repeat what stays verbatim.
 */

import { latestCompaction } from "../lib/compaction-boundary.ts";

/** The fields of a session entry the cut reads; pi's `SessionEntry` fits it. */
export type CutEntry = {
	id: string;
	type: string;
	message?: { role?: string; stopReason?: string; content?: unknown };
	targetId?: string;
	replacement?: { content: unknown } | null;
	firstKeptEntryId?: string | null;
};

type Span<M> = { messagesToSummarize: M[]; turnPrefixMessages: M[]; isSplitTurn: boolean };
type Preparation<M> = Span<M> & { firstKeptEntryId: string };

/** What pi summarizes for a preparation: the messages before the cut, a split turn's prefix included. */
export function doomedMessages<M>(preparation: Span<M>): M[] {
	return preparation.isSplitTurn ? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages] : preparation.messagesToSummarize;
}

/**
 * pi's preparation moved to Claude Code's cut, with the entry the kept tail
 * starts at. pi's own when its cut already is the reply, no reply is still in
 * context, or the messages to take off are not the doomed span's tail.
 */
export function claudeCodeCut<E extends CutEntry, M extends { role: string }, P extends Preparation<M>>(
	entries: readonly E[],
	preparation: P,
	toMessages: (entry: E) => M[],
): { preparation: P; firstKeptEntryId: string } {
	const unchanged = { preparation, firstKeptEntryId: preparation.firstKeptEntryId };
	const cut = lastReplyCut(entries, preparation.firstKeptEntryId);
	if (!cut) return unchanged;
	const moved = moveCut(preparation, spanMessages(cut.span, entries, toMessages), cut.later);
	return moved ? { preparation: moved, firstKeptEntryId: cut.firstKeptEntryId } : unchanged;
}

/**
 * The entry Claude Code's cut keeps from, and the entries between it and pi's
 * cut: summarized too when the reply is `later` than pi's cut, kept when it is
 * earlier. Undefined when pi's entry is not on the branch, no reply is still
 * in context, or pi already cut at the reply.
 *
 * An assistant message that ended in an error or an abort never reaches the
 * provider (pi-ai's `transformMessages` drops it), and one whose content (as
 * a context edit leaves it) has no text or tool call is omitted or skipped by
 * its converter, so none of them is a reply to keep. A reply an
 * earlier compaction already summarized is out of reach.
 */
export function lastReplyCut<E extends CutEntry>(
	entries: readonly E[],
	piFirstKeptEntryId: string,
): { firstKeptEntryId: string; span: E[]; later: boolean } | undefined {
	const piIndex = entries.findIndex((entry) => entry.id === piFirstKeptEntryId);
	if (piIndex < 0) return undefined;
	const edits = contextEdits(entries);
	const start = latestCompaction(entries)?.keptStart ?? 0;
	let replyIndex = -1;
	for (let i = entries.length - 1; i >= start; i--) {
		const entry = entries[i];
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		// The content the provider gets: a context edit's replacement, or none when it omits the message.
		const content = edits.has(entry.id) ? edits.get(entry.id)?.content : message.content;
		if (!sendsContent(content)) continue;
		replyIndex = i;
		break;
	}
	if (replyIndex < 0 || replyIndex === piIndex) return undefined;
	const later = replyIndex > piIndex;
	return {
		firstKeptEntryId: entries[replyIndex].id,
		span: later ? entries.slice(piIndex, replyIndex) : entries.slice(replyIndex, piIndex),
		later,
	};
}

/** Each edited entry's replacement (null when the edit omits it), the latest edit winning, as in pi's projection. */
function contextEdits(entries: readonly CutEntry[]): Map<string, CutEntry["replacement"]> {
	const edits = new Map<string, CutEntry["replacement"]>();
	for (const entry of entries) if (entry.type === "context_edit" && entry.targetId) edits.set(entry.targetId, entry.replacement);
	return edits;
}

/** Whether an assistant message carries text or a tool call (thinking alone is not a reply). */
function sendsContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	return (
		Array.isArray(content) &&
		content.some((block: { type?: string; text?: string }) => block?.type === "toolCall" || (block?.type === "text" && !!block.text?.trim()))
	);
}

/**
 * The context messages of entries in branch order, as pi projects them: an
 * omitted entry contributes nothing, a replaced one its replacement content
 * (`buildSessionProjection` in pi 0.87 and later; earlier pi has no edits), and
 * an older compaction entry inside the span nothing (only the newest
 * compaction's summary is context).
 */
export function spanMessages<E extends CutEntry, M extends { role: string }>(span: readonly E[], all: readonly E[], toMessages: (entry: E) => M[]): M[] {
	const edits = contextEdits(all);
	return span.flatMap((entry) => {
		if (entry.type === "compaction" || entry.type === "context_edit") return [];
		const messages = toMessages(entry);
		if (!edits.has(entry.id)) return messages;
		const replacement = edits.get(entry.id);
		if (!replacement) return [];
		return messages.map((message) => {
			if (!["user", "assistant", "toolResult", "custom"].includes(message.role)) return message;
			const content =
				(message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
					? [{ type: "text", text: replacement.content }]
					: replacement.content;
			return { ...message, content };
		});
	});
}

/**
 * pi's preparation with the doomed span moved to the new cut, the split turn's
 * prefix folded in: `messages` appended when the reply is `later` than pi's
 * cut, else taken off the span's end. Undefined when those are not the span's
 * tail (role and timestamp, message by message) or would leave nothing to
 * summarize: pi's cut stays.
 */
export function moveCut<P extends Span<unknown>>(preparation: P, messages: P["messagesToSummarize"], later: boolean): P | undefined {
	const doomed = doomedMessages(preparation);
	const moved = (messagesToSummarize: P["messagesToSummarize"]): P => ({ ...preparation, messagesToSummarize, turnPrefixMessages: [], isSplitTurn: false });
	if (later) return moved([...doomed, ...messages]);
	const keep = doomed.length - messages.length;
	if (keep <= 0) return undefined;
	const same = (a: unknown, b: unknown) => {
		const [x, y] = [a as { role?: string; timestamp?: number } | null, b as { role?: string; timestamp?: number } | null];
		return x?.role === y?.role && x?.timestamp === y?.timestamp;
	};
	if (messages.some((message, i) => !same(message, doomed[keep + i]))) return undefined;
	return moved(doomed.slice(0, keep));
}
