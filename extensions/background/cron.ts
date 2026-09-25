/**
 * Session cron (pure) — the store behind cron_create / cron_list / cron_delete
 * and fixed-interval /loop.
 *
 * Claude Code's cron is a session-only, in-memory schedule of prompts, each
 * re-invoking the session verbatim when its 5-field local-time expression
 * matches (findings §21). This module holds the parts with no timers: the
 * expression parser, the next-match search, the human cadence text, and the
 * store's due/expiry bookkeeping. The extension owns the single timer and decides WHEN to call
 * `takeDue` (only while idle), so a job due mid-turn fires once at settle.
 *
 * Parsing, matching and cadence text follow Claude Code 2.1.281 exactly:
 * numeric fields only (`*`, `* /n`, `a`, `a-b`, `a-b/n`, lists), day-of-week 7
 * is Sunday, day-of-month and day-of-week OR together when both are
 * restricted, and a job whose expression matches nothing within a year is
 * rejected. Fire times carry Claude Code's deterministic jitter (`JITTER`).
 */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { sliceColumns, visibleWidth } from "../lib/text-width.ts";

/** Claude Code's per-session job cap. */
export const MAX_JOBS = 50;
/** Recurring jobs expire after 7 days: they fire one final time, then are deleted. */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RECURRING_MAX_AGE_DAYS = RECURRING_MAX_AGE_MS / 86_400_000;
/**
 * Claude Code's jitter constants (2.1.282; findings §21). The tool
 * description tells the model "up to 10% of their period late (max 15 min)";
 * the code fires up to 50% late, capped at 30 minutes. We match the code.
 */
export const JITTER = {
	recurringFrac: 0.5,
	recurringCapMs: 1_800_000,
	oneShotMaxMs: 90_000,
	oneShotFloorMs: 0,
	oneShotMinuteMod: 30,
	/** A plain every-5-minutes job fires this much before the period ends, as Claude Code's does. */
	cacheLeadMs: 15_000,
} as const;
const FIVE_MINUTES_MS = 300_000;
const PLAIN_STEP_MINUTES = /^\*\/\d+ \* \* \* \*$/;

/** A job's fixed jitter fraction in [0, 1): its id's first 8 hex digits over 2^32. */
export function jitterFraction(id: string): number {
	const value = Number.parseInt(id.slice(0, 8), 16) / 4_294_967_296;
	return Number.isFinite(value) ? value : 0;
}

/**
 * A recurring job's next fire after `from`, as Claude Code computes it: the next
 * match plus up to half the period (capped), by the job's fraction. A plain
 * `*\/N` job whose period is exactly 5 minutes (to within the lead) fires 15 s
 * before the period ends instead, measured from `from`.
 */
export function nextRecurringFire(cron: string, fields: CronFields, from: number, id: string): number | null {
	const first = nextMatch(fields, new Date(from));
	if (!first) return null;
	const second = nextMatch(fields, first);
	if (!second) return first.getTime();
	const period = second.getTime() - first.getTime();
	const lead = JITTER.cacheLeadMs;
	if (PLAIN_STEP_MINUTES.test(cron.trim()) && lead > 0 && lead < period && period >= FIVE_MINUTES_MS && period - lead < FIVE_MINUTES_MS) {
		return from + period - lead;
	}
	return first.getTime() + Math.min(jitterFraction(id) * JITTER.recurringFrac * period, JITTER.recurringCapMs);
}

/**
 * A one-shot job's fire, as Claude Code computes it: its match, or up to 90 s
 * earlier when the match falls on :00 or :30, never before it was created.
 */
export function oneShotFire(fields: CronFields, createdAt: number, id: string): number | null {
	const match = nextMatch(fields, new Date(createdAt));
	if (!match) return null;
	if (match.getMinutes() % JITTER.oneShotMinuteMod !== 0) return match.getTime();
	const early = JITTER.oneShotFloorMs + jitterFraction(id) * (JITTER.oneShotMaxMs - JITTER.oneShotFloorMs);
	return Math.max(match.getTime() - early, createdAt);
}

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

/** Who made the job: the model (cron_create, /loop's fixed interval included) or schedule_wakeup (a one-shot, as in Claude Code). */
export type CronSource = "model" | "wakeup";

export interface CronJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	source: CronSource;
	/** A subagent's task id when the job is that agent's (lib/agent-cron.ts). */
	agentId?: string;
	/** A subagent job's working directory, where its fire resolves loop.md and skills. */
	cwd?: string;
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
	/** false fires on the exact match (tests); Claude Code's jitter otherwise. */
	jitter?: boolean;
}

/** The session's jobs, keyed by id, with no timers of its own. */
export class CronStore {
	private readonly jobs = new Map<string, CronJob & { fields: CronFields }>();
	private readonly maxJobs: number;
	private readonly maxAgeMs: number;
	private readonly newId: () => string;
	private readonly jitter: boolean;

	constructor(options: CronStoreOptions = {}) {
		this.maxJobs = options.maxJobs ?? MAX_JOBS;
		this.maxAgeMs = options.maxAgeMs ?? RECURRING_MAX_AGE_MS;
		this.newId = options.newId ?? (() => randomUUID().slice(0, 8));
		this.jitter = options.jitter ?? true;
	}

	/** The fire after `from`: the exact next match without jitter, Claude Code's jittered time with it. */
	private fireAfter(job: { id: string; cron: string; recurring: boolean; fields: CronFields }, from: number): number | null {
		if (!this.jitter) return nextMatch(job.fields, new Date(from))?.getTime() ?? null;
		return job.recurring ? nextRecurringFire(job.cron, job.fields, from, job.id) : oneShotFire(job.fields, from, job.id);
	}

	/** Validate and add a job, with Claude Code's error wording. */
	/**
	 * `fireAt` pins the first fire to an exact time instead of the next match: a
	 * wakeup fires `delaySeconds` from now, its cron (`M H * * *`) only naming
	 * that minute for cron_list, as in Claude Code.
	 */
	create(input: { cron: string; prompt: string; recurring?: boolean; source?: CronSource; fireAt?: number; agentId?: string; cwd?: string }, now: number): CreateResult {
		const fields = parseCron(input.cron);
		if (!fields) return { ok: false, error: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.` };
		if (!nextMatch(fields, new Date(now))) return { ok: false, error: `Cron expression '${input.cron}' does not match any calendar date in the next year.` };
		// The cap is cron_create's check, as in Claude Code; a wakeup is never refused.
		if (input.source !== "wakeup" && this.jobs.size >= this.maxJobs) return { ok: false, error: `Too many scheduled jobs (max ${this.maxJobs}). Cancel one first.` };
		let id = this.newId();
		while (this.jobs.has(id)) id = this.newId();
		const base = { id, cron: input.cron.trim(), recurring: input.recurring ?? true, fields };
		const job = {
			...base,
			prompt: input.prompt,
			source: input.source ?? "model",
			...(input.agentId !== undefined && { agentId: input.agentId }),
			...(input.cwd !== undefined && { cwd: input.cwd }),
			createdAt: now,
			nextFireAt: input.fireAt ?? this.fireAfter(base, now)!,
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
			const next = job.recurring ? this.fireAfter(job, now) : null;
			const expired = job.recurring && now - job.createdAt >= this.maxAgeMs;
			const final = !job.recurring || expired || next === null;
			fires.push({ job: publicJob(job), final });
			if (final) this.jobs.delete(job.id);
			else job.nextFireAt = next!;
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

/**
 * Claude Code's `CronList` clip of a prompt (its `truncate(text, 80, true)`):
 * a multi-line prompt shows its first line plus "…", and a line wider than
 * 80 columns is cut to 79 plus "…". Loosened no-truncation rule:
 * decisions/tools.md, "Model-facing text is persisted past its cap".
 */
export function clipPrompt(prompt: string, max = 80): string {
	const newline = prompt.indexOf("\n");
	if (newline !== -1) {
		const first = prompt.slice(0, newline);
		return visibleWidth(first) + 1 > max ? cutToWidth(`${first}…`, max) : `${first}…`;
	}
	return visibleWidth(prompt) <= max ? prompt : cutToWidth(prompt, max);
}

/** Claude Code's cut: the text to `max - 1` columns plus "…". */
function cutToWidth(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	return max <= 1 ? "…" : `${sliceColumns(text, max - 1).text}…`;
}

export function formatJobLine(job: CronJob): string {
	return `${job.id} — ${describeCadence(job.cron)} (${job.recurring ? "recurring" : "one-shot"}) [session-only]: ${clipPrompt(job.prompt)}`;
}

export function formatJobList(jobs: CronJob[]): string {
	return jobs.length ? jobs.map(formatJobLine).join("\n") : "No scheduled jobs.";
}

export function formatDeleteResult(id: string): string {
	return `Cancelled job ${id}.`;
}

export function formatUnknownJob(id: string): string {
	return `No scheduled job with id '${id}'`;
}

export function formatCannotFire(): string {
	return "This is a one-shot session: it ends when this turn does, so the job will never fire.";
}

/**
 * Claude Code's descriptions with the durable feature off, the names swapped
 * to ours and "Claude" read as "this session" (the model behind One Code may
 * be any). The jitter sentence is Claude Code's own, understating its code.
 */
export const CRON_CREATE_DESCRIPTION = `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

## Session-only

Jobs live only in this session — nothing is written to disk, and the job is gone when the session ends.

## Not for live watching

cron_create re-runs a prompt at fixed wall-clock intervals. To watch a log file, process, or command output and be notified the moment something changes, use the monitor tool instead — monitor streams events as they happen; cron polls on a schedule.

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${RECURRING_MAX_AGE_DAYS} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${RECURRING_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to cron_delete.`;

export const CRON_CREATE_PARAMS = {
	cron: 'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
	prompt: "The prompt to enqueue at each fire time.",
	/** Claude Code's text with its durable mode off, as on the account One Code matches (decisions/tools.md, "Session cron"). */
	durable: "Has no effect — durable persistence is not available. All jobs are session-only (in-memory, gone when this session ends).",
	recurring: `true (default) = fire on every cron match until deleted or auto-expired after ${RECURRING_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
};

export const CRON_LIST_DESCRIPTION = "List all cron jobs scheduled via cron_create in this session.";

/**
 * The three tools' parameters, shared by the main session's tools and a
 * subagent's proxies (lib/agent-cron.ts). `durable` is accepted and ignored,
 * as in Claude Code with its durable mode off; cron_list and cron_delete stay
 * open to stray fields like our other tools (deepseek sends `query` to an
 * empty schema; decisions/tools.md, "Session cron").
 */
export const CRON_CREATE_PARAMETERS = Type.Object(
	{
		cron: Type.String({ description: CRON_CREATE_PARAMS.cron }),
		prompt: Type.String({ description: CRON_CREATE_PARAMS.prompt }),
		recurring: Type.Optional(Type.Boolean({ description: CRON_CREATE_PARAMS.recurring })),
		durable: Type.Optional(Type.Boolean({ description: CRON_CREATE_PARAMS.durable })),
	},
	{ additionalProperties: false },
);
export const CRON_LIST_PARAMETERS = Type.Object({});

export const CRON_DELETE_DESCRIPTION = "Cancel a cron job previously scheduled with cron_create. Removes it from the in-memory session store.";
export const CRON_DELETE_ID_DESCRIPTION = "Job ID returned by cron_create.";
export const CRON_DELETE_PARAMETERS = Type.Object({ id: Type.String({ description: CRON_DELETE_ID_DESCRIPTION }) });
