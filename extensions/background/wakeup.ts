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

import { knobValue } from "../lib/knobs.ts";
import { type CronStore, RECURRING_MAX_AGE_MS } from "../lib/agents/cron.ts";

export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3600;
/** Claude Code's keepalive fallback delay and budget. */
export const KEEPALIVE_DELAY_SECONDS = 1200;
export const KEEPALIVE_BUDGET = 1;

export function clampDelaySeconds(delay: number): number {
	if (!Number.isFinite(delay)) return MIN_DELAY_SECONDS;
	return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(delay)));
}

/** An env flag as Claude Code reads a boolean: unset is `fallback`, a false-like value is off. */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** Keepalive is on unless the `LOOP_KEEPALIVE` knob (lib/knobs.ts) turns it off. */
export function keepaliveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlag(knobValue("LOOP_KEEPALIVE", env), true);
}

export interface WakeupSchedule {
	scheduledFor: number;
	clampedDelaySeconds: number;
	wasClamped: boolean;
	/** The store's job id, so a cron_delete of it is matched when the branch is replayed. */
	jobId?: string;
	/** When this prompt's loop started: its age carries across a /reload. */
	startedAt: number;
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

	/** When the loop for `prompt` started, if it is running. */
	chainStart(prompt: string): number | undefined {
		return this.ages.get(prompt)?.startedAt;
	}

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
		const created = this.store.create({ cron: `${target.getMinutes()} ${target.getHours()} * * *`, prompt, recurring: false, source: "wakeup", fireAt: scheduledFor }, now);
		this.ages.set(prompt, { startedAt, lastScheduledFor: scheduledFor });
		if (viaKeepalive) this.misses++;
		return { scheduledFor, clampedDelaySeconds: clamped, wasClamped, startedAt, ...(created.ok ? { jobId: created.job.id } : {}) };
	}

	/**
	 * Take back a pending wakeup's loop state from the branch (a /reload, a
	 * /tree switch): its age, and whether the keepalive armed it, which spends
	 * the loop's one fallback.
	 */
	restoreChain(prompt: string, startedAt: number, scheduledFor: number, viaKeepalive: boolean): void {
		this.ages.set(prompt, { startedAt, lastScheduledFor: scheduledFor });
		this.misses = viaKeepalive ? 1 : 0;
	}

	/**
	 * `stop: true`: cancel every pending wakeup; the count is the result's.
	 * The cancelled prompts and the one in flight forget their age, so a
	 * restarted loop gets a fresh 7 days (Claude Code's `forgetChainStart`).
	 */
	stop(): number {
		const cancelled = this.store.deleteWhere((job) => job.source === "wakeup");
		for (const job of cancelled) this.ages.delete(job.prompt);
		if (this.inFlight !== null) this.ages.delete(this.inFlight);
		this.inFlight = null;
		this.misses = 0;
		return cancelled.length;
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

// ── What the texts read (the words are the profile's, text.ts WakeupText) ───

/** schedule_wakeup's result as data: the local clock time it fires, how far off, and the delay used when it was clamped. */
export function scheduledText(result: WakeupSchedule, now: number): { clock: string; inSeconds: number; clampedTo?: number } {
	return {
		clock: new Date(result.scheduledFor).toTimeString().slice(0, 8),
		inSeconds: Math.max(0, Math.round((result.scheduledFor - now) / 1000)),
		...(result.wasClamped ? { clampedTo: result.clampedDelaySeconds } : {}),
	};
}
