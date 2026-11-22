/**
 * How long the model last thought, for the working line's `thought for Ns`
 * segment (pure; the clock is passed in). Claude Code's line reads
 * `(12s · ↓ 60.8k tokens · thought for 1s)` in a capture; its reconstructed
 * source (a lead) times each thinking run from its start to its end, rounds
 * to whole seconds with a floor of 1 s, and shows the result for 2 s.
 */

/** How long the segment stays after a thinking run ends (Claude Code's, from the lead). */
export const THOUGHT_SHOWN_MS = 2000;

export class ThinkingClock {
	private startedAt: number | undefined;
	private last: { durationMs: number; endedAt: number } | undefined;

	/** A thinking run starts; a start while one runs keeps the first. */
	start(now: number): void {
		this.startedAt ??= now;
	}

	/** The run ends; an end with no start does nothing. */
	end(now: number): void {
		if (this.startedAt === undefined) return;
		this.last = { durationMs: Math.max(0, now - this.startedAt), endedAt: now };
		this.startedAt = undefined;
	}

	/**
	 * The message ended: a run still open never got its end (a stream error,
	 * an abort before a retry) and is dropped, so the next run times from its
	 * own start. The last finished run still shows.
	 */
	messageEnded(): void {
		this.startedAt = undefined;
	}

	/** The turn is over: nothing to show. */
	reset(): void {
		this.startedAt = undefined;
		this.last = undefined;
	}

	/** `thought for Ns` while the last run ended under `THOUGHT_SHOWN_MS` ago, else undefined. */
	segment(now: number): string | undefined {
		if (!this.last || now - this.last.endedAt >= THOUGHT_SHOWN_MS) return undefined;
		return `thought for ${Math.max(1, Math.round(this.last.durationMs / 1000))}s`;
	}
}
