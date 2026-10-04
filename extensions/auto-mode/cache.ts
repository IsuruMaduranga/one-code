/** Anthropic-only wire layout. Never changes classifier text or verdict behavior. */

import { MAX_SIDE_CALL_CACHE_MARKERS, topLevelMarkerCount } from "../lib/side-call-cache.ts";

interface TextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
}

/**
 * Keep each history entry at a stable block boundary. A single growing history
 * block cannot hit the previous call's shorter block. Mark the last history
 * entry, not the pending action, closing tag or stage instruction.
 *
 * Also mark the previous call's history boundary when it is still in range.
 * That makes it an explicit lookup even after more than Anthropic's 20-block
 * lookback of new entries. The index is only a cache hint: compaction, a branch
 * switch or different framing naturally misses, never reuses stale text.
 * Two history marks plus pi-ai's system marks (two with OAuth) fit the limit of
 * four. The classifier has no tools and exactly one user message. The marks
 * only use free slots: if pi-ai ever puts more markers on the system or tools,
 * the previous-call mark goes first, then the edit is skipped, so a pi change
 * can cost a cache miss but never a rejected (and so fail-closed) request.
 */
export function cacheClassifierHistory(payload: unknown, parts: readonly string[], historyEnd: number, previousEnd?: number): void {
	const body = payload as { messages?: { role: string; content: TextBlock[] }[] } | undefined;
	const message = body?.messages?.[0];
	if (body?.messages?.length !== 1 || message?.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return;
	const original = message.content[0];
	// Preserve pi-ai's wire text if a provider transform (e.g. removing unpaired
	// Unicode surrogates) changed it. Caching is optional; the complete payload is not.
	if (original.type !== "text" || original.text !== parts.join("") || !original.cache_control) return;
	// The user message's own marker is replaced, so its slot is ours to reuse.
	const free = MAX_SIDE_CALL_CACHE_MARKERS - topLevelMarkerCount(body);
	if (free < 1) return;
	const markPrevious = free >= 2 && previousEnd !== undefined && previousEnd < historyEnd;
	message.content = parts.map((text, i) => ({
		type: "text",
		text,
		...(i === historyEnd || (markPrevious && i === previousEnd) ? { cache_control: original.cache_control } : {}),
	}));
}
