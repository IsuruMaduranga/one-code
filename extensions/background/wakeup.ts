/**
 * schedule_wakeup (pure): Claude Code's self-paced `/loop` timer, 2.1.282
 * (findings §21). A wakeup is a one-shot job in the session's CronStore
 * (source "wakeup"), so cron_list shows it and
 * one timer fires everything. Its cron names the target minute
 * (`M H * * *`); the fire itself is the exact target time.
 *
 * `DynamicLoop` is Claude Code's loop core: one pending wakeup (a new one
 * supersedes the rest), a 7-day age per prompt, `stop` cancelling every
 * wakeup, and the keepalive: a turn that ran a wakeup and ended without
 * scheduling the next gets one 1200 s fallback, and a second miss ends the
 * loop. Texts are Claude Code's with our tool names.
 */

import { type CronStore, RECURRING_MAX_AGE_MS } from "./cron.ts";

export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3600;
/** Claude Code's keepalive fallback delay and budget. */
export const KEEPALIVE_DELAY_SECONDS = 1200;
export const KEEPALIVE_BUDGET = 1;

export function clampDelaySeconds(delay: number): number {
	if (!Number.isFinite(delay)) return MIN_DELAY_SECONDS;
	return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(delay)));
}

/** Keepalive is on unless `CLAUDE_CODE_LOOP_KEEPALIVE` turns it off. */
export function keepaliveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.CLAUDE_CODE_LOOP_KEEPALIVE;
	if (value === undefined) return true;
	return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export interface WakeupSchedule {
	scheduledFor: number;
	clampedDelaySeconds: number;
	wasClamped: boolean;
}

interface PromptAge {
	startedAt: number;
	lastScheduledFor: number;
	agedOut?: boolean;
}

export class DynamicLoop {
	/** The wakeup prompt whose turn is running, for the keepalive (Claude Code's in-flight tick). */
	inFlight: string | null = null;
	private misses = 0;
	private readonly ages = new Map<string, PromptAge>();

	constructor(
		private readonly store: CronStore,
		private readonly maxAgeMs = RECURRING_MAX_AGE_MS,
	) {}

	/** A pending wakeup exists. */
	hasPending(): boolean {
		return this.store.list().some((job) => job.source === "wakeup");
	}

	/**
	 * Claude Code's shared scheduling step: null when the loop for this prompt
	 * is past its maximum age, which ends it.
	 */
	schedule(delaySeconds: number, prompt: string, now: number, viaKeepalive = false): WakeupSchedule | null {
		if (!viaKeepalive) this.misses = 0;
		this.store.deleteWhere((job) => job.source === "wakeup");
		const age = this.ages.get(prompt);
		const stale = age !== undefined && now > age.lastScheduledFor + MAX_DELAY_SECONDS * 1000;
		const startedAt = age === undefined || stale ? now : age.startedAt;
		if (this.maxAgeMs > 0 && now - startedAt >= this.maxAgeMs) {
			if (!age?.agedOut) this.ages.set(prompt, { startedAt, lastScheduledFor: now - (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS) * 1000, agedOut: true });
			return null;
		}
		const clamped = clampDelaySeconds(delaySeconds);
		const wasClamped = !(delaySeconds >= MIN_DELAY_SECONDS && delaySeconds <= MAX_DELAY_SECONDS);
		const scheduledFor = now + clamped * 1000;
		const target = new Date(scheduledFor);
		this.store.create({ cron: `${target.getMinutes()} ${target.getHours()} * * *`, prompt, recurring: false, source: "wakeup", fireAt: scheduledFor }, now);
		this.ages.set(prompt, { startedAt, lastScheduledFor: scheduledFor });
		if (viaKeepalive) this.misses++;
		return { scheduledFor, clampedDelaySeconds: clamped, wasClamped };
	}

	/** `stop: true`: cancel every pending wakeup; the count is the result's. */
	stop(): number {
		const cancelled = this.store.deleteWhere((job) => job.source === "wakeup").length;
		this.inFlight = null;
		this.misses = 0;
		return cancelled;
	}

	/**
	 * A turn ended. When it ran a wakeup and left none pending, re-arm once at
	 * the keepalive delay; past the budget the loop ends.
	 */
	settle(now: number, keepalive = keepaliveEnabled()): "none" | "armed" | "ended" {
		const prompt = this.inFlight;
		this.inFlight = null;
		if (prompt === null || !keepalive || this.hasPending()) return "none";
		if (this.misses >= KEEPALIVE_BUDGET) return "ended";
		return this.schedule(KEEPALIVE_DELAY_SECONDS, prompt, now, true) ? "armed" : "ended";
	}

	clear(): void {
		this.inFlight = null;
		this.misses = 0;
		this.ages.clear();
	}
}

// ── Model-facing text (Claude Code 2.1.282, our tool names) ────────────────

export function formatScheduled(result: WakeupSchedule, now: number): string {
	const at = new Date(result.scheduledFor).toTimeString().slice(0, 8);
	const inSeconds = Math.max(0, Math.round((result.scheduledFor - now) / 1000));
	const clamped = result.wasClamped ? ` (clamped to ${result.clampedDelaySeconds}s from your requested value)` : "";
	return `Next wakeup scheduled for ${at} (in ${inSeconds}s)${clamped}. Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`;
}

export const AGED_OUT_RESULT = "Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue.";

export function formatStopped(cancelled: number): string {
	const monitor = "If you armed a monitor for this loop, task_stop it now; otherwise nothing more to do this turn.";
	if (cancelled === 0) {
		return `Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with cron_delete. ${monitor}`;
	}
	return `Loop stopped — cancelled ${cancelled} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${monitor}`;
}

export const WAKEUP_ERRORS = {
	delayAndReason: "`delaySeconds` and `reason` are required when `stop` is not true.",
	prompt: "`prompt` is required when `stop` is not true.",
	noop: "`noop` is required when `stop` is not true.",
} as const;

/**
 * Claude Code's description for a session whose prompt-cache TTL it cannot
 * name (its third branch): One Code runs on any provider, so the 1-hour and
 * 5-minute branches, which assume Anthropic billing, never apply as such.
 */
export const SCHEDULE_WAKEUP_DESCRIPTION = `Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.

Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted. Instead schedule a long fallback (1200s+) so the loop survives if the work hangs or never notifies. The exception is external work the harness cannot track (a CI run, a deploy, a remote queue) — there, pick a delay matched to how fast that state actually changes.

Pass the same /loop prompt back via \`prompt\` each turn so the next firing repeats the task. For an autonomous /loop (no user prompt), pass the literal sentinel \`<<autonomous-loop-dynamic>>\` as \`prompt\` instead — the runtime resolves it back to the autonomous-loop instructions at fire time. (There is a similar \`<<autonomous-loop>>\` sentinel for cron_create-based autonomous loops; do not confuse the two — schedule_wakeup always uses the \`-dynamic\` variant.) To end the loop, call this tool with \`stop: true\` (omit every other field) — the loop ends immediately and no further wakeups fire.

Set \`noop: true\` if nothing changed — you checked and there's nothing to report ("no change", "still waiting", "quiet hold"). Set \`noop: false\` if something happened worth keeping — you edited a file, posted a message, advanced state, or surfaced a finding. Consecutive \`noop: true\` ticks are collapsed in the user's terminal view and tracked as a streak, so long quiet holds stay legible to the user without scrolling. Omit \`noop\` when stopping (\`stop: true\`).

## Picking delaySeconds

The Anthropic prompt cache decides how expensive a wake-up is: waking inside the cache TTL re-reads your conversation context cached (fast, cheap); waking past it re-reads everything uncached. The TTL depends on how the session is billed: Claude subscriber sessions get a 1-hour TTL (dropping to 5 minutes during usage overage), while API-key, Bedrock, and Vertex sessions default to 5 minutes.

In either regime: never schedule extra wakeups just to keep the cache warm — they cost more than the cache miss they avoid. Match the delay to what you're actually waiting for: when actively polling external state the harness can't notify you about (a CI run, a deploy, a remote queue), pick the delay from how fast that state actually changes; for idle ticks with no specific signal to watch, default to **1200s–1800s** (20–30 min) — the user can always interrupt if they need you sooner.

On a 5-minute TTL only, two refinements: under 300s (60s–270s) the cache stays warm, so prefer 270s over 300s when actively polling (300s is the worst-of-both — you pay the miss without amortizing it); and commit to 1200s+ rather than repeated ~300s waits, so one cache miss buys a long wait.

The runtime clamps to [60, 3600], so you don't need to clamp yourself.

## The reason field

One short sentence on what you chose and why. Goes to telemetry and is shown back to the user. "watching CI run" beats "waiting." The user reads this to understand what you're doing without having to predict your cadence in advance — make it specific.
`;

export const SCHEDULE_WAKEUP_PARAMS = {
	delaySeconds: "Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless `stop` is true.",
	reason: "One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific. Required unless `stop` is true.",
	prompt:
		"The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead (the dynamic-pacing variant, not the cron_create-mode `<<autonomous-loop>>`). Required unless `stop` is true.",
	stop: "Set to true to end the dynamic loop immediately instead of scheduling another wakeup. When true, all other fields are ignored and no further wakeups fire.",
	noop: "true = nothing changed (you checked and there is nothing to report). false = something happened worth keeping (edited a file, posted a message, advanced state, surfaced a finding). Consecutive noop:true ticks are collapsed in the user's terminal view and tracked as a streak. Required unless `stop` is true.",
} as const;
