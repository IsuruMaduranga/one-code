/**
 * Session cron (pure) — the store behind cron_create / cron_list / cron_delete
 * and fixed-interval /loop.
 *
 * Claude Code's cron is a session-only, in-memory schedule of prompts, each
 * re-invoking the session verbatim when its 5-field local-time expression
 * matches (findings §21). This module holds the parts with no timers: the
 * expression parser, the next-match search, the human cadence text, the
 * interval-to-cron conversion /loop uses, and the store's due/expiry
 * bookkeeping. The extension owns the single timer and decides WHEN to call
 * `takeDue` (only while idle), so a job due mid-turn fires once at settle.
 *
 * Parsing, matching and cadence text follow Claude Code 2.1.281 exactly:
 * numeric fields only (`*`, `* /n`, `a`, `a-b`, `a-b/n`, lists), day-of-week 7
 * is Sunday, day-of-month and day-of-week OR together when both are
 * restricted, and a job whose expression matches nothing within a year is
 * rejected.
 */

import { randomUUID } from "node:crypto";

/** Claude Code's per-session job cap. */
export const MAX_JOBS = 50;
/** Recurring jobs expire after 7 days: they fire one final time, then are deleted. */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RECURRING_MAX_AGE_DAYS = RECURRING_MAX_AGE_MS / 86_400_000;
/** The next-match search walks at most one leap year of minutes. */
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

export interface CronFields {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
}

const FIELD_RANGES = [
	{ min: 0, max: 59 },
	{ min: 0, max: 23 },
	{ min: 1, max: 31 },
	{ min: 1, max: 12 },
	{ min: 0, max: 6 },
] as const;

function parseField(text: string, range: { min: number; max: number }): number[] | null {
	const { min, max } = range;
	const isDayOfWeek = min === 0 && max === 6;
	const values = new Set<number>();
	for (const part of text.split(",")) {
		const star = part.match(/^\*(?:\/(\d+))?$/);
		if (star) {
			const step = star[1] ? Number.parseInt(star[1], 10) : 1;
			if (step < 1) return null;
			for (let v = min; v <= max; v += step) values.add(v);
			continue;
		}
		const span = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
		if (span) {
			const lo = Number.parseInt(span[1], 10);
			const hi = Number.parseInt(span[2], 10);
			const step = span[3] ? Number.parseInt(span[3], 10) : 1;
			// Day-of-week accepts 7 as Sunday at the top of a range.
			const top = isDayOfWeek ? 7 : max;
			if (lo > hi || step < 1 || lo < min || hi > top) return null;
			for (let v = lo; v <= hi; v += step) values.add(isDayOfWeek && v === 7 ? 0 : v);
			continue;
		}
		if (/^\d+$/.test(part)) {
			let v = Number.parseInt(part, 10);
			if (isDayOfWeek && v === 7) v = 0;
			if (v < min || v > max) return null;
			values.add(v);
			continue;
		}
		return null;
	}
	if (values.size === 0) return null;
	return [...values].sort((a, b) => a - b);
}

/** Parse a 5-field cron expression; null when it is malformed. */
export function parseCron(expr: string): CronFields | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const fields: number[][] = [];
	for (let i = 0; i < 5; i++) {
		const values = parseField(parts[i], FIELD_RANGES[i]);
		if (!values) return null;
		fields.push(values);
	}
	return { minute: fields[0], hour: fields[1], dayOfMonth: fields[2], month: fields[3], dayOfWeek: fields[4] };
}

/**
 * The first local-time minute strictly after `from` that matches, or null when
 * nothing matches within a year. Walks forward in local time, skipping whole
 * months, days and hours that cannot match, so DST gaps and repeats follow the
 * platform's `Date` arithmetic the way Claude Code's scheduler does.
 */
export function nextMatch(fields: CronFields, from: Date): Date | null {
	const minutes = new Set(fields.minute);
	const hours = new Set(fields.hour);
	const doms = new Set(fields.dayOfMonth);
	const months = new Set(fields.month);
	const dows = new Set(fields.dayOfWeek);
	const anyDom = fields.dayOfMonth.length === 31;
	const anyDow = fields.dayOfWeek.length === 7;
	const t = new Date(from.getTime());
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);
	for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++) {
		if (!months.has(t.getMonth() + 1)) {
			t.setMonth(t.getMonth() + 1, 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}
		const dom = t.getDate();
		const dow = t.getDay();
		const dayMatches = anyDom && anyDow ? true : anyDom ? dows.has(dow) : anyDow ? doms.has(dom) : doms.has(dom) || dows.has(dow);
		if (!dayMatches) {
			t.setDate(t.getDate() + 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}
		if (!hours.has(t.getHours())) {
			t.setHours(t.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (!minutes.has(t.getMinutes())) {
			t.setMinutes(t.getMinutes() + 1);
			continue;
		}
		return t;
	}
	return null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clockTime(minute: number, hour: number): string {
	return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Claude Code's human-readable cadence ("Every 5 minutes", "Weekdays at 9:00 AM"); the raw expression otherwise. */
export function describeCadence(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [min, hour, dom, month, dow] = parts;
	const restAny = dom === "*" && month === "*" && dow === "*";
	if (hour === "*" && restAny) {
		if (min === "*") return "Every minute";
		const step = min.match(/^\*\/(\d+)$/);
		if (step) {
			const n = Number.parseInt(step[1], 10);
			return n === 1 ? "Every minute" : `Every ${n} minutes`;
		}
	}
	if (/^\d+$/.test(min) && hour === "*" && restAny) {
		const m = Number.parseInt(min, 10);
		return m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}`;
	}
	const hourStep = hour.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(min) && hourStep && restAny) {
		const n = Number.parseInt(hourStep[1], 10);
		const m = Number.parseInt(min, 10);
		const at = m === 0 ? "" : ` at :${String(m).padStart(2, "0")}`;
		return n === 1 ? `Every hour${at}` : `Every ${n} hours${at}`;
	}
	if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return expr;
	const time = clockTime(Number.parseInt(min, 10), Number.parseInt(hour, 10));
	if (restAny) return `Every day at ${time}`;
	if (dom === "*" && month === "*" && /^\d$/.test(dow)) {
		const day = WEEKDAYS[Number.parseInt(dow, 10) % 7];
		if (day) return `Every ${day} at ${time}`;
	}
	if (dom === "*" && month === "*" && dow === "1-5") return `Weekdays at ${time}`;
	return expr;
}

/**
 * A `/loop` interval token (`5m`, `2h`, `1d`) as the cron expression Claude
 * Code's loop skill converts it to. Seconds round up to whole minutes (cron's
 * granularity). An interval that does not divide its unit evenly (`7m`, `90m`,
 * `5h`) rounds to the nearest one that does, ties going to the longer, and
 * `rounded` names what it became so the caller can tell the user.
 */
export function intervalToCron(token: string): { cron: string; rounded?: string } | { error: string } {
	const m = token.trim().match(/^(\d+)\s*([smhd])$/i);
	if (!m) return { error: `"${token}" is not an interval. Use a number with s, m, h or d, e.g. 5m, 2h, 1d.` };
	const exact = Number.parseInt(m[1], 10) * { s: 1 / 60, m: 1, h: 60, d: 1440 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
	if (exact <= 0) return { error: "The interval must be at least 1 minute." };
	const minutes = Math.ceil(exact);
	let cron: string;
	let actual: string;
	if (minutes < 60) {
		const n = nearest(minutes, [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]);
		cron = n === 1 ? "* * * * *" : `*/${n} * * * *`;
		actual = `${n}m`;
	} else if (minutes < 1440) {
		const n = nearest(minutes / 60, [1, 2, 3, 4, 6, 8, 12]);
		cron = n === 1 ? "0 * * * *" : `0 */${n} * * *`;
		actual = `${n}h`;
	} else {
		const n = Math.round(minutes / 1440);
		if (n > 28) return { error: `Every ${n}d is longer than cron's day-of-month step can express. Use at most 28d.` };
		cron = n === 1 ? "0 0 * * *" : `0 0 */${n} * *`;
		actual = `${n}d`;
	}
	return toMinutes(actual) === exact ? { cron } : { cron, rounded: actual };
}

function nearest(value: number, choices: number[]): number {
	let best = choices[0];
	for (const c of choices) if (Math.abs(c - value) <= Math.abs(best - value)) best = c;
	return best;
}

function toMinutes(interval: string): number {
	const n = Number.parseInt(interval, 10);
	return interval.endsWith("d") ? n * 1440 : interval.endsWith("h") ? n * 60 : n;
}

export type CronSource = "model" | "loop";

export interface CronJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	source: CronSource;
	createdAt: number;
	/** Epoch ms of the next fire. */
	nextFireAt: number;
}

export interface CronFire {
	job: CronJob;
	/** The job is gone after this fire: a one-shot, or a recurring job past its 7-day age. */
	final: boolean;
}

export type CreateResult = { ok: true; job: CronJob } | { ok: false; error: string };

export interface CronStoreOptions {
	maxJobs?: number;
	maxAgeMs?: number;
	newId?: () => string;
}

/** The session's jobs, keyed by id, with no timers of its own. */
export class CronStore {
	private readonly jobs = new Map<string, CronJob & { fields: CronFields }>();
	private readonly maxJobs: number;
	private readonly maxAgeMs: number;
	private readonly newId: () => string;

	constructor(options: CronStoreOptions = {}) {
		this.maxJobs = options.maxJobs ?? MAX_JOBS;
		this.maxAgeMs = options.maxAgeMs ?? RECURRING_MAX_AGE_MS;
		this.newId = options.newId ?? (() => randomUUID().slice(0, 8));
	}

	/** Validate and add a job, with Claude Code's error wording. */
	create(input: { cron: string; prompt: string; recurring?: boolean; source?: CronSource }, now: number): CreateResult {
		const fields = parseCron(input.cron);
		if (!fields) return { ok: false, error: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.` };
		const next = nextMatch(fields, new Date(now));
		if (!next) return { ok: false, error: `Cron expression '${input.cron}' does not match any calendar date in the next year.` };
		if (this.jobs.size >= this.maxJobs) return { ok: false, error: `Too many scheduled jobs (max ${this.maxJobs}). Cancel one first.` };
		let id = this.newId();
		while (this.jobs.has(id)) id = this.newId();
		const job = {
			id,
			cron: input.cron.trim(),
			prompt: input.prompt,
			recurring: input.recurring ?? true,
			source: input.source ?? "model",
			createdAt: now,
			nextFireAt: next.getTime(),
			fields,
		};
		this.jobs.set(id, job);
		return { ok: true, job: publicJob(job) };
	}

	delete(id: string): boolean {
		return this.jobs.delete(id);
	}

	get(id: string): CronJob | undefined {
		const job = this.jobs.get(id);
		return job && publicJob(job);
	}

	/** Every job, in creation order. */
	list(): CronJob[] {
		return [...this.jobs.values()].map(publicJob);
	}

	get size(): number {
		return this.jobs.size;
	}

	/** Epoch ms of the earliest pending fire, for arming the one timer. */
	nextFireAt(): number | undefined {
		let earliest: number | undefined;
		for (const job of this.jobs.values()) if (earliest === undefined || job.nextFireAt < earliest) earliest = job.nextFireAt;
		return earliest;
	}

	/**
	 * Claim every job due at `now`. Each fires once however many of its matches
	 * passed (a turn that ran through three ticks yields one fire, not three);
	 * a recurring job re-arms to its next match after `now`, and a one-shot or
	 * an expired recurring job is deleted.
	 */
	takeDue(now: number): CronFire[] {
		const fires: CronFire[] = [];
		for (const job of this.jobs.values()) {
			if (job.nextFireAt > now) continue;
			const next = job.recurring ? nextMatch(job.fields, new Date(now)) : null;
			const expired = job.recurring && now - job.createdAt >= this.maxAgeMs;
			const final = !job.recurring || expired || next === null;
			fires.push({ job: publicJob(job), final });
			if (final) this.jobs.delete(job.id);
			else job.nextFireAt = next!.getTime();
		}
		return fires;
	}

	/** Remove every job matching `predicate`; returns the removed jobs. */
	deleteWhere(predicate: (job: CronJob) => boolean): CronJob[] {
		const removed: CronJob[] = [];
		for (const job of this.jobs.values()) {
			const view = publicJob(job);
			if (predicate(view)) {
				this.jobs.delete(job.id);
				removed.push(view);
			}
		}
		return removed;
	}

	clear(): void {
		this.jobs.clear();
	}
}

function publicJob(job: CronJob & { fields?: CronFields }): CronJob {
	const { fields: _fields, ...rest } = job;
	return rest;
}

// ── Model-facing text (Claude Code's wording, our tool names) ───────────────

const SESSION_ONLY = "Session-only (not written to disk, dies when this session ends)";

export function formatCreateResult(job: CronJob): string {
	const cadence = describeCadence(job.cron);
	return job.recurring
		? `Scheduled recurring job ${job.id} (${cadence}). ${SESSION_ONLY}. Auto-expires after ${RECURRING_MAX_AGE_DAYS} days. Use cron_delete to cancel sooner.`
		: `Scheduled one-shot task ${job.id} (${cadence}). ${SESSION_ONLY}. It will fire once then auto-delete.`;
}

export function formatJobLine(job: CronJob): string {
	return `${job.id} — ${describeCadence(job.cron)} (${job.recurring ? "recurring" : "one-shot"}) [session-only]: ${job.prompt}`;
}

export function formatJobList(jobs: CronJob[]): string {
	return jobs.length ? jobs.map(formatJobLine).join("\n") : "No scheduled jobs.";
}

export function formatDeleteResult(id: string): string {
	return `Cancelled job ${id}.`;
}

export function formatUnknownJob(id: string): string {
	return `No scheduled job with id '${id}'.`;
}
