/**
 * One Code's cron text (the profile's `text.background.cron`): Claude Code's
 * descriptions with the durable feature off, the names swapped to ours and
 * "Claude" read as "this session" (the model behind One Code may be any). The
 * jitter sentence is Claude Code's own, understating its code.
 */

import type { CronCreateFailure, CronText, ShownJob } from "../../../extensions/background/text.ts";

const SESSION_ONLY = "Session-only (not written to disk, dies when this session ends)";

const jobLine = (job: ShownJob) => `${job.id} — ${job.cadence} (${job.recurring ? "recurring" : "one-shot"}) [session-only]: ${job.prompt}`;

function createFailed(failure: CronCreateFailure): string {
	switch (failure.kind) {
		case "invalid":
			return `Invalid cron expression '${failure.cron}'. Expected 5 fields: M H DoM Mon DoW.`;
		case "neverMatches":
			return `Cron expression '${failure.cron}' does not match any calendar date in the next year.`;
		case "tooMany":
			return `Too many scheduled jobs (max ${failure.max}). Cancel one first.`;
	}
}

export const cron: CronText = {
	createDescription: ({ maxAgeDays }) => `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

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

Recurring tasks auto-expire after ${maxAgeDays} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${maxAgeDays}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to cron_delete.`,
	createParams: ({ maxAgeDays }) => ({
		cron: 'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
		prompt: "The prompt to enqueue at each fire time.",
		recurring: `true (default) = fire on every cron match until deleted or auto-expired after ${maxAgeDays} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
		/** Claude Code's text with its durable mode off, as on the account One Code matches (decisions/tools.md, "Session cron"). */
		durable: "Has no effect — durable persistence is not available. All jobs are session-only (in-memory, gone when this session ends).",
	}),
	listDescription: "List all cron jobs scheduled via cron_create in this session.",
	deleteDescription: "Cancel a cron job previously scheduled with cron_create. Removes it from the in-memory session store.",
	deleteIdParam: "Job ID returned by cron_create.",
	created: ({ job, maxAgeDays }) =>
		job.recurring
			? `Scheduled recurring job ${job.id} (${job.cadence}). ${SESSION_ONLY}. Auto-expires after ${maxAgeDays} days. Use cron_delete to cancel sooner.`
			: `Scheduled one-shot task ${job.id} (${job.cadence}). ${SESSION_ONLY}. It will fire once then auto-delete.`,
	createFailed,
	list: ({ jobs }) => (jobs.length ? jobs.map(jobLine).join("\n") : "No scheduled jobs."),
	deleted: ({ id }) => `Cancelled job ${id}.`,
	unknownJob: ({ id }) => `No scheduled job with id '${id}'`,
	neverFires: "This is a one-shot session: it ends when this turn does, so the job will never fire.",
	notOwner: ({ id }) => `Cannot delete cron job '${id}': owned by another agent`,
	blockingRunRefusal:
		"Nothing was scheduled: this agent runs until its task is done and then ends, so a job it schedules could never fire. Do the work now, or report back so the main session can schedule it.",
	storeMissing: "The session's cron store is not loaded; nothing was scheduled.",
};
