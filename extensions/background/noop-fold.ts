/**
 * Claude Code's no-op folding for self-paced `/loop` (2.1.282, findings §21).
 * When a wakeup fires and the tick since the previous wakeup changed nothing
 * (the model called schedule_wakeup with `noop: true`, and nothing vetoes
 * it), that tick is folded: its messages leave the model's context and the
 * new wakeup carries the streak, shown as
 * `Resuming /loop wakeup (<time>) · <N> no-op ticks since <time>` and told to
 * the model as `[<N> prior /loop wakeups found nothing actionable; loop is
 * healthy.]`.
 *
 * `decideFold` applies Claude Code's rules to the session branch, run at fire
 * time; its answer is stored on the new wakeup message, so `applyNoopFolds`
 * (the `context` handler) gives the same context on every request. pi cannot
 * remove messages already drawn, so the terminal keeps the folded tick above
 * the streak line.
 *
 * Pure: no pi imports.
 */

/** The wakeup fire message's details that record a fold. */
export interface FoldDetails {
	noOpStreak?: number;
	streakStartedAt?: number;
}

/** The slice of a session entry the fold reads. */
export type FoldEntry =
	| { kind: "wakeup"; timestamp: number; details?: FoldDetails }
	| { kind: "fire" }
	| { kind: "compaction" }
	| { kind: "assistant"; toolCalls: Array<{ id: string; name: string; noop?: unknown }>; aborted: boolean }
	| { kind: "toolResult"; toolCallId: string }
	| { kind: "user" }
	| { kind: "other" };

export type FoldDecision =
	| { kind: "none" }
	| { kind: "veto"; reason: string }
	| { kind: "fold"; priorStreak: number; since: number };

/** Should the tick since the last wakeup fold into the one firing now? */
export function decideFold(entries: readonly FoldEntry[]): FoldDecision {
	let anchorIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].kind === "wakeup") {
			anchorIdx = i;
			break;
		}
	}
	if (anchorIdx === -1) return { kind: "none" };
	const anchor = entries[anchorIdx] as Extract<FoldEntry, { kind: "wakeup" }>;
	for (let i = anchorIdx - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "wakeup") break;
		if (entry.kind === "fire" || entry.kind === "compaction") return { kind: "veto", reason: "blocking_system_before_anchor" };
	}
	let noop: boolean | undefined;
	const calls = new Set<string>();
	for (let i = anchorIdx + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.kind === "wakeup" || entry.kind === "fire" || entry.kind === "compaction") return { kind: "veto", reason: "blocking_system_in_span" };
		if (entry.kind === "assistant") {
			if (entry.aborted) return { kind: "veto", reason: "tool_abort" };
			for (const call of entry.toolCalls) {
				calls.add(call.id);
				if (call.name === "schedule_wakeup") noop = call.noop === true;
			}
		} else if (entry.kind === "toolResult") {
			if (!calls.has(entry.toolCallId)) return { kind: "veto", reason: "split_tool_pair" };
		} else if (entry.kind === "user") {
			return { kind: "veto", reason: "foreign_user_input" };
		}
	}
	if (noop !== true) return { kind: "veto", reason: "model_reported_work" };
	return { kind: "fold", priorStreak: anchor.details?.noOpStreak ?? 0, since: anchor.details?.streakStartedAt ?? anchor.timestamp };
}

/** Claude Code's note to the model in place of the folded ticks. */
export function foldCompanion(streak: number): string {
	return `[${streak} prior /loop ${streak === 1 ? "wakeup" : "wakeups"} found nothing actionable; loop is healthy.]`;
}

/** The streak part of the wakeup line, after `Resuming /loop wakeup (<time>)`. */
export function foldSuffix(streak: number, since: string): string {
	return ` · ${streak} no-op ${streak === 1 ? "tick" : "ticks"} since ${since}`;
}

interface ContextMessage {
	role: string;
	customType?: string;
	details?: unknown;
	timestamp?: number;
}

const WAKEUP_TYPE = "wakeup";

function streakOf(message: ContextMessage): number {
	if (message.role !== "custom" || message.customType !== WAKEUP_TYPE) return 0;
	const streak = (message.details as FoldDetails | undefined)?.noOpStreak;
	return typeof streak === "number" && streak > 0 ? streak : 0;
}

/**
 * The model's context with every folded tick removed: before a wakeup that
 * carries a streak, drop everything back to (and including) the previous
 * wakeup and the note in front of it, and put the note for this streak in
 * front of it. Unchanged when nothing folded.
 */
export function applyNoopFolds<M extends ContextMessage>(messages: readonly M[], companion: (text: string, timestamp: number) => M): M[] | undefined {
	if (!messages.some((m) => streakOf(m) > 0)) return undefined;
	const out: M[] = [];
	const companions = new Set<M>();
	let lastWakeup = -1;
	for (const message of messages) {
		const streak = streakOf(message);
		if (streak > 0 && lastWakeup !== -1) {
			let cut = lastWakeup;
			if (cut > 0 && companions.has(out[cut - 1])) cut--;
			out.length = cut;
			const note = companion(foldCompanion(streak), message.timestamp ?? Date.now());
			companions.add(note);
			out.push(note);
		}
		if (message.role === "custom" && message.customType === WAKEUP_TYPE) lastWakeup = out.length;
		out.push(message);
	}
	return out;
}
