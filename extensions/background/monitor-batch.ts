/**
 * Monitor event batching (pure). A monitor turns every stdout line into a
 * steered notification; `tail -f` on a busy log used to mean an unbounded
 * batch every second, each one a turn when the session was idle. Two limits:
 *
 * - a batch shows at most MAX_LINES lines / MAX_CHARS characters and says how
 *   many more arrived (the full stream stays behind `task_output`);
 * - while the agent is mid-turn the flush window widens (BUSY_MS), so events
 *   coalesce into one notification at the next tool boundary instead of one
 *   steer per second. Idle, the short window keeps latency low; the turn it
 *   starts then widens the window for what follows.
 */

export const MONITOR_BATCH_MAX_LINES = 50;
export const MONITOR_BATCH_MAX_CHARS = 4_000;
export const MONITOR_BATCH_IDLE_MS = 1_000;
export const MONITOR_BATCH_BUSY_MS = 10_000;

export interface MonitorBatch {
	/** Lines kept for display, in order (at most MAX_LINES). */
	shown: string[];
	/** Lines that arrived beyond the cap; counted, not kept. */
	overflow: number;
}

export function emptyBatch(): MonitorBatch {
	return { shown: [], overflow: 0 };
}

/** Add one event line, keeping the batch bounded. */
export function pushEvent(batch: MonitorBatch, line: string): void {
	if (batch.shown.length < MONITOR_BATCH_MAX_LINES) batch.shown.push(line);
	else batch.overflow++;
}

export function batchSize(batch: MonitorBatch): number {
	return batch.shown.length + batch.overflow;
}

/** The notification body for one flushed batch. */
export function formatMonitorBatch(id: string, description: string, batch: MonitorBatch): string {
	const total = batchSize(batch);
	const lines: string[] = [];
	let chars = 0;
	let hidden = batch.overflow;
	for (const line of batch.shown) {
		if (chars + line.length + 1 > MONITOR_BATCH_MAX_CHARS && lines.length > 0) {
			hidden += batch.shown.length - lines.length;
			break;
		}
		const shown = line.length > MONITOR_BATCH_MAX_CHARS ? `${line.slice(0, MONITOR_BATCH_MAX_CHARS)}…` : line;
		lines.push(shown);
		chars += shown.length + 1;
	}
	const head = `Monitor ${id} (${description}) emitted ${total} event(s):`;
	const more = hidden > 0 ? `\n… +${hidden} more line(s) not shown — task_output ${id} has the full stream` : "";
	return `${head}\n${lines.join("\n")}${more}`;
}
