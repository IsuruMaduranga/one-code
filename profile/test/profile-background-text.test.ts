/**
 * One Code's background wording (profile/text/background/) for what the golden
 * snapshot cannot reach: a full job store, a subagent's refusals, a wakeup
 * whose loop aged out or that had nothing to cancel, and what a background
 * monitor and task_stop say outside a one-shot run, a monitor batch's
 * overflow line, and the no-op loop fold's note. The golden snapshot pins
 * the bytes of every other text; background-wiring.test.ts covers the
 * monitor's empty output, its batches and task_output's clip.
 */
import { describe, expect, it } from "vitest";
import { shownJob } from "../../extensions/lib/agents/cron.ts";
import { background } from "../text/background/index.ts";
import { backgroundWords } from "../../extensions/tools/background/text.ts";

const { cron, wakeup, monitor, tasks } = backgroundWords(background);

describe("One Code's cron text", () => {
	it("words a full store and a subagent's refusals", () => {
		expect(cron.createFailed({ kind: "tooMany", max: 50 })).toBe("Too many scheduled jobs (max 50). Cancel one first.");
		expect(cron.notOwner({ id: "2427a4e2" })).toBe("Cannot delete cron job '2427a4e2': owned by another agent");
		expect(cron.blockingRunRefusal).toMatch(/^Nothing was scheduled: this agent runs until its task is done/);
		expect(cron.storeMissing).toBe("The session's cron store is not loaded; nothing was scheduled.");
	});

	it("lists jobs through the base's cadence reading and clip", () => {
		const job = { id: "2427a4e2", cron: "*/7 * * * *", prompt: "Say the word ping.", recurring: true, source: "model" as const, createdAt: 0, nextFireAt: 0 };
		expect(cron.list({ jobs: [shownJob(job), shownJob({ ...job, id: "8a527832", cron: "3 9 28 12 *", recurring: false, prompt: "One-shot\ntest" })] })).toBe(
			"2427a4e2 — Every 7 minutes (recurring) [session-only]: Say the word ping.\n8a527832 — 3 9 28 12 * (one-shot) [session-only]: One-shot…",
		);
		expect(cron.list({ jobs: [] })).toBe("No scheduled jobs.");
	});
});

describe("One Code's schedule_wakeup text", () => {
	it("words an aged-out loop and a stop with nothing to cancel", () => {
		expect(wakeup.agedOut).toBe("Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue.");
		expect(wakeup.stopped({ cancelled: 0 })).toContain("cancel it with cron_delete. If you armed a monitor for this loop, task_stop it now;");
		expect(wakeup.scheduled({ clock: "14:05:09", inSeconds: 300 })).toBe(
			"Next wakeup scheduled for 14:05:09 (in 300s). Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.",
		);
	});
});

describe("One Code's monitor and task tool text", () => {
	it("words a background monitor and an aborted one-shot monitor", () => {
		expect(monitor.started({ id: "b1234567", description: "logs" })).toBe(
			"Monitor b1234567 started (logs). Events arrive as task notifications; stop with task_stop, inspect with task_output.",
		);
		expect(monitor.ranToEnd({ id: "b1234567", description: "logs", end: { kind: "aborted" }, events: 1, note: "N.", output: "x" })).toBe(
			"Monitor b1234567 (logs) stopped (tool call aborted) after 1 event(s). N.\n\nx",
		);
		expect(monitor.spoolLost({ keptChars: 200_000 })).toBe(
			"[The monitor's spool file could not be written, so only the last 200,000 characters of its output were kept.]\n",
		);
		expect(monitor.startFailed({ kind: "noShell" })).toBe("Cannot start the monitor: no bash shell was found");
	});

	it("counts the lines a batch left out on a line of their own", () => {
		expect(monitor.moreLines({ hidden: 25, taskId: "m1" })).toBe("\n… +25 more line(s) not shown — task_output m1 has the full stream");
	});

	it("words task_stop's outcomes and the task line", () => {
		expect(tasks.alreadyEnded({ id: "b1", status: "completed" })).toBe("Task b1 is already completed.");
		expect(tasks.stopRequested({ id: "b1", description: "logs" })).toBe("Stop requested for b1 (logs).");
		expect(tasks.residentEnded({ id: "b1", description: "review" })).toMatch(/^Terminated the resident agent behind b1 \(review\)/);
		const line = { id: "b1", kind: "monitor", status: "running", description: "logs", seconds: 5, finished: false };
		expect(tasks.taskLine(line)).toBe("b1 [monitor] running · logs · started 5s ago");
		expect(tasks.taskLine({ ...line, status: "completed", finished: true })).toBe("b1 [monitor] completed · logs · started 5s");
	});
});

describe("One Code's loop text", () => {
	it("words the no-op fold's note the way Claude Code does", () => {
		expect(background.loop.foldNote({ streak: 1 })).toBe("[1 prior /loop wakeup found nothing actionable; loop is healthy.]");
		expect(background.loop.foldNote({ streak: 3 })).toBe("[3 prior /loop wakeups found nothing actionable; loop is healthy.]");
	});
});
