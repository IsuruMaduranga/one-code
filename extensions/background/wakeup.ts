/**
 * schedule_wakeup helpers (pure) — Claude Code's self-paced /loop timer.
 *
 * A fired wakeup or loop tick is a RE-INVOCATION, not a notification: Claude
 * Code enqueues the scheduled prompt verbatim as the next turn's input, behind
 * a dim "Running scheduled task" line in the TUI (findings §21), so the model
 * reads its own task back exactly as it wrote it. These builders therefore
 * return the prompt as-is; the TUI shows the line (`scheduledTaskComponent`).
 */

export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3600;

export function clampDelaySeconds(delay: number): number {
	if (!Number.isFinite(delay)) return MIN_DELAY_SECONDS;
	return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(delay)));
}

export interface WakeupRequest {
	delaySeconds: number;
	prompt: string;
	reason: string;
	/** Nothing changed this tick (matches CC's /loop noop flag). Recorded for callers; no effect on scheduling. */
	noop?: boolean;
}

export interface ParsedLoop {
	/** undefined = dynamic (model self-paces via schedule_wakeup); set = fixed interval. */
	intervalSeconds?: number;
	task: string;
}

/**
 * Parse `/loop` arguments: a leading duration token (`5m`, `30s`, `2h`) selects
 * fixed-interval mode and the rest is the task; no duration selects dynamic
 * (self-paced) mode. `stop` / `status` are handled by the caller, not here.
 */
export function parseLoopArgs(raw: string): ParsedLoop {
	const m = raw.trim().match(/^(\d+)\s*(s|m|h)\b\s*([\s\S]*)$/i);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2].toLowerCase();
		const seconds = unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
		return { intervalSeconds: seconds, task: m[3].trim() };
	}
	return { task: raw.trim() };
}

/** The turn input a fixed-interval `/loop` tick delivers: the task, verbatim (CC's cron fire). */
export function buildLoopMessage(task: string): string {
	return task;
}

/**
 * The opening turn of a dynamic (self-paced) `/loop`: the user's command, so it
 * reads as their instruction — drive schedule_wakeup, pass the task back each
 * time. Unframed: it is the user's `/loop`, not a harness event.
 */
export function buildDynamicLoopPrompt(task: string): string {
	return [
		"Self-paced loop started. Work the task below now. When this iteration is done, call schedule_wakeup to schedule the next one — choose delaySeconds by what you're waiting for, and pass the same task back as `prompt`. End the loop with schedule_wakeup {stop: true} when the task is complete or the user says to stop.",
		"",
		task,
	].join("\n");
}

/** The turn input a fired wakeup delivers: the scheduled prompt, verbatim (CC re-invokes with it). */
export function buildWakeupMessage(request: WakeupRequest): string {
	return request.prompt;
}

export function describeSchedule(request: WakeupRequest): string {
	const clamped = clampDelaySeconds(request.delaySeconds);
	const minutes = Math.round((clamped / 60) * 10) / 10;
	const adjusted =
		clamped !== request.delaySeconds
			? ` (adjusted from ${request.delaySeconds}s — the allowed range is ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS}s)`
			: "";
	return `Wake-up scheduled in ${clamped}s (~${minutes}min)${adjusted}: ${request.reason}`;
}
