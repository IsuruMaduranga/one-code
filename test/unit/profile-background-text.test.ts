/**
 * One Code's background wording (profile/background/) for what the golden
 * snapshot cannot reach: a full job store, a subagent's refusals, a wakeup
 * whose loop aged out or that had nothing to cancel. The golden snapshot
 * pins the bytes of every other cron and wakeup text.
 */
import { describe, expect, it } from "vitest";
import { shownJob } from "../../extensions/background/cron.ts";
import { background } from "../../profile/background/index.ts";

const { cron, wakeup } = background;

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
