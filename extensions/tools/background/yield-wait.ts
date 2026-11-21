/**
 * The wait behind the `yield` tool (Claude Code 2.1.327's flagged `Yield`,
 * findings §94): block until something the model is waiting for happens,
 * then say what. Checked in Claude Code's order: a notification handed to pi
 * (it is delivered right after the tool result), a message the user queued,
 * a scheduled prompt that is due (cron and wakeups fire only while the session
 * is idle), and nothing left that could report. An abort and the wait cap end
 * it too.
 *
 * A finished task whose notification is still coalescing is not "nothing
 * running": the wait goes on until that notification is handed to pi, so the
 * reply after the wait always has it.
 *
 * Pure: no pi imports. The tool wires the probes (extensions/tools/background/index.ts).
 */

import type { YieldEnd } from "./text.ts";

/** How long one yield may block before it returns and the model decides to wait again. */
export const YIELD_CAP_MS = 60 * 60_000;
/** How often the probes are read between events. */
const POLL_MS = 200;

export interface YieldProbes {
	/** Notifications not yet delivered: still coalescing, or handed to pi. */
	backlog(): { coalescing: number; handed: number };
	/** Background tasks still running (shells, monitors, agents, workflows). */
	running(): number;
	/** The user typed a message that waits for this turn. */
	userMessageQueued(): boolean;
	/** A cron job or wakeup is due. */
	scheduledDue(): boolean;
	/** Subscribe to "a notification was handed to pi"; returns the unsubscribe. */
	onHanded(listener: () => void): () => void;
}

/** What ends the wait now, or undefined to keep waiting. */
export function yieldEnd(probes: YieldProbes, handedSinceStart: boolean, aborted: boolean, waitedMs: number, capMs = YIELD_CAP_MS): YieldEnd | undefined {
	if (aborted) return { kind: "interrupted" };
	const backlog = probes.backlog();
	if (handedSinceStart || backlog.handed > 0) return { kind: "delivered" };
	if (probes.userMessageQueued()) return { kind: "message" };
	if (probes.scheduledDue()) return { kind: "scheduled" };
	const running = probes.running();
	if (running === 0 && backlog.coalescing === 0) return { kind: "nothingRunning" };
	if (waitedMs >= capMs) return { kind: "cap", running };
	return undefined;
}

/** Block until `yieldEnd` says why; resolves with the reason. */
export function waitForBackground(probes: YieldProbes, signal: AbortSignal | undefined, capMs = YIELD_CAP_MS, now: () => number = Date.now): Promise<YieldEnd> {
	const startedAt = now();
	return new Promise((resolve) => {
		let handed = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const finish = (end: YieldEnd) => {
			clearInterval(timer);
			unsubscribe();
			signal?.removeEventListener("abort", check);
			resolve(end);
		};
		function check() {
			const end = yieldEnd(probes, handed, signal?.aborted === true, now() - startedAt, capMs);
			if (end) finish(end);
		}
		const unsubscribe = probes.onHanded(() => {
			handed = true;
			check();
		});
		signal?.addEventListener("abort", check, { once: true });
		timer = setInterval(check, POLL_MS);
		check();
	});
}
