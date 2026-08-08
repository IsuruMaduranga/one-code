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
