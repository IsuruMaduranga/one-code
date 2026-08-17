/**
 * schedule_wakeup helpers (pure) — Claude Code's self-paced /loop timer.
 */

import { systemNotification } from "../lib/notifications.ts";

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

/** A loop follow-up: an instruction line, a blank, then the task — system-framed. */
function framedLoop(lead: string, task: string): string {
	return systemNotification([lead, "", task].join("\n"));
}

/** The follow-up a fixed-interval `/loop` tick delivers. */
export function buildLoopMessage(task: string): string {
	return framedLoop(
		"Loop tick — run the task below now. This repeats automatically on the interval and keeps firing until the user runs `/loop stop`.",
		task,
	);
}

/** The opening message for a dynamic (self-paced) `/loop` — instructs the model to drive schedule_wakeup. */
export function buildDynamicLoopPrompt(task: string): string {
	return framedLoop(
		"Self-paced loop started. Work the task below now. When this iteration is done, call schedule_wakeup to schedule the next one — choose delaySeconds by what you're waiting for, and pass the same task back as `prompt`. End the loop with schedule_wakeup {stop: true} when the task is complete or the user says to stop.",
		task,
	);
}

/** The follow-up message a fired wakeup delivers. Framed so it never reads as user input. */
export function buildWakeupMessage(request: WakeupRequest): string {
	return systemNotification(
		[
			`Scheduled wake-up fired (reason given when scheduled: ${request.reason}).`,
			"Continue the task below; when done, either schedule the next wake-up with schedule_wakeup or end the loop with schedule_wakeup {stop: true}.",
			"",
			request.prompt,
		].join("\n"),
	);
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
