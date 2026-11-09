/**
 * One Code's words for the background tools (monitor, task_output/task_stop,
 * schedule_wakeup, the cron tools and /loop), in Claude Code's phrasing where
 * it has one. The base's wiring of them is test/unit/background-wiring.test.ts.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECURRING_MAX_AGE_DAYS as maxAgeDays } from "../../extensions/lib/agents/cron.ts";
import { STORED_OUTPUT_CAP } from "../../extensions/lib/shell-run/bash-background.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";
import { background } from "../text/background/index.ts";
import { notificationsText } from "../text/notifications/index.ts";
import { toolResults } from "../text/tool-results/index.ts";

const { cron, wakeup, monitor, tasks, loop } = background;
const notifications = notificationsText(ALL_LIVE);

describe("monitor notifications", () => {
	it("names a mid-run batch and a stream's end as Claude Code does", () => {
		expect(notifications.summary({ kind: "monitorEvent", description: "many lines" })).toBe('Monitor event: "many lines"');
		expect(notifications.summary({ kind: "monitorEnded", description: "many lines", status: "completed", produced: true })).toBe('Monitor "many lines" stream ended');
	});

	it("closes a batch that left lines out with the count and where the rest is", () => {
		expect(monitor.moreLines({ hidden: 10, taskId: "b1234567" })).toContain("+10 more line(s) not shown — task_output b1234567 has the full stream");
	});
});

describe("task_output and task_stop", () => {
	it("words a stop request, an unknown id and a finished monitor's silence", () => {
		expect(tasks.stopRequested({ id: "b1", description: "long runner" })).toContain("Stop requested");
		expect(tasks.unknownTask({ id: "nope", known: [] })).toContain('No background task "nope"');
		expect(tasks.unknownTask({ id: "anything", known: [] })).toContain("Known tasks: (none)");
		expect(monitor.noOutput).toBe("(no output — the monitor received no events and nothing on stderr)");
		expect(tasks.noOutputYet).toContain("(no output yet)");
	});

	it("heads a clipped stream with its spool file", () => {
		const path = join("/sessions", "monitor", "b1", "output.log");
		expect(tasks.clippedHeader({ path }).startsWith(`[Truncated. Full output: ${path}]`)).toBe(true);
	});
});

describe("schedule_wakeup", () => {
	it("says when the wakeup fires, and when its delay was clamped", () => {
		expect(wakeup.scheduled({ clock: "12:01:00", inSeconds: 60, clampedTo: 60 })).toBe(
			"Next wakeup scheduled for 12:01:00 (in 60s) (clamped to 60s from your requested value). Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.",
		);
	});

	it("rejects a missing field with Claude Code's errors", () => {
		expect(wakeup.missing("delayAndReason")).toBe("`delaySeconds` and `reason` are required when `stop` is not true.");
		expect(wakeup.missing("prompt")).toBe("`prompt` is required when `stop` is not true.");
		expect(wakeup.missing("noop")).toBe("`noop` is required when `stop` is not true.");
	});

	it("stops the loop with Claude Code's text, and says a fixed-interval /loop is not stopped by it", () => {
		expect(wakeup.stopped({ cancelled: 1 })).toBe(
			"Loop stopped — cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled. If you armed a monitor for this loop, task_stop it now; otherwise nothing more to do this turn.",
		);
		expect(wakeup.stopped({ cancelled: 0 })).toContain(
			"there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with cron_delete.",
		);
	});
});

describe("the cron tools", () => {
	it("confirms a one-shot and a recurring job in Claude Code's words", () => {
		expect(cron.created({ job: { id: "00000001", cadence: "30 14 25 9 *", recurring: false, prompt: "check the deploy" }, maxAgeDays })).toBe(
			"Scheduled one-shot task 00000001 (30 14 25 9 *). Session-only (not written to disk, dies when this session ends). It will fire once then auto-delete.",
		);
		const recurring = cron.created({ job: { id: "00000002", cadence: "Every 10 minutes", recurring: true, prompt: "poll ci" }, maxAgeDays });
		expect(recurring).toContain("(Every 10 minutes). Session-only");
		expect(recurring).toContain("Auto-expires after 7 days. Use cron_delete to cancel sooner.");
	});

	it("lists jobs one per line, and says when there are none", () => {
		expect(cron.list({ jobs: [] })).toBe("No scheduled jobs.");
		expect(cron.list({ jobs: [{ id: "00000003", cadence: "Every day at 12:01 PM", recurring: false, prompt: "check the build" }] })).toBe(
			"00000003 — Every day at 12:01 PM (one-shot) [session-only]: check the build",
		);
		const two = cron.list({
			jobs: [
				{ id: "00000004", cadence: "Every day at 12:01 PM", recurring: false, prompt: "agent check" },
				{ id: "00000005", cadence: "Every 10 minutes", recurring: true, prompt: "main job" },
			],
		});
		expect(two.split("\n")).toHaveLength(2);
	});

	it("fails loud with Claude Code's errors", () => {
		expect(cron.createFailed({ kind: "invalid", cron: "every 5 minutes" })).toBe("Invalid cron expression 'every 5 minutes'. Expected 5 fields: M H DoM Mon DoW.");
		expect(cron.unknownJob({ id: "deadbeef" })).toBe("No scheduled job with id 'deadbeef'");
		expect(cron.notOwner({ id: "00000006" })).toBe("Cannot delete cron job '00000006': owned by another agent");
	});

	it("says a one-shot session never fires the job, and that durable has no effect", () => {
		expect(cron.neverFires).toBe("This is a one-shot session: it ends when this turn does, so the job will never fire.");
		expect(cron.createParams({ maxAgeDays }).durable).toBe(
			"Has no effect — durable persistence is not available. All jobs are session-only (in-memory, gone when this session ends).",
		);
	});
});

describe("/loop", () => {
	it("builds the skill body around the user's input", () => {
		const body = loop.skillBody({ form: { kind: "prompt", input: "5m check CI" }, loopFile: null, persistent: false, maxAgeDays });
		expect(body).toContain("# /loop — schedule a recurring or self-paced prompt");
		expect(body.endsWith("## Input\n\n5m check CI")).toBe(true);
	});

	it("sends the autonomous instructions on the first fire, then the short tick", () => {
		const tick = loop.tick("autonomous");
		const full = loop.withPreamble({ persistent: false, tick });
		expect(full.startsWith("# Autonomous loop check")).toBe(true);
		expect(full).toContain("\n\n---\n\n# Autonomous loop tick");
		expect(tick.startsWith("# Autonomous loop tick")).toBe(true);
	});

	it("folds no-op wakeups into one note", () => {
		expect(loop.foldNote({ streak: 1 })).toBe("[1 prior /loop wakeup found nothing actionable; loop is healthy.]");
	});
});

describe("a one-shot monitor's result", () => {
	const note = notifications.oneShotNote("monitor");

	it("names how it ended and how many events it saw", () => {
		expect(monitor.ranToEnd({ id: "b1", description: "one-shot", end: { kind: "completed" }, events: 3, note, output: "ev1\nev2\nev3" })).toContain("completed after 3 event(s)");
		expect(monitor.ranToEnd({ id: "b2", description: "aborted", end: { kind: "aborted" }, events: 0, note, output: monitor.noEvents })).toContain(
			"stopped (tool call aborted) after 0 event(s)",
		);
		expect(note).toBe("This is a one-shot session, so the monitor ran to completion instead of in the background.");
	});

	it("heads an output whose spool was lost, and words the persisted copy", () => {
		expect(monitor.spoolLost({ keptChars: STORED_OUTPUT_CAP })).toContain(
			"[The monitor's spool file could not be written, so only the last 200,000 characters of its output were kept.]",
		);
		expect(monitor.earlierTruncated).toContain("earlier output truncated");
		expect(toolResults.persisted({ size: "1KB", file: "/x/output.log" })).toContain("Full output saved to: /x/output.log");
		expect(toolResults.previewHeading({ kb: 2 })).toBe("Preview (first 2KB):");
	});
});
