import { describe, expect, it } from "vitest";
import { CronStore } from "../../extensions/background/cron.ts";
import {
	AGED_OUT_RESULT,
	DynamicLoop,
	formatScheduled,
	formatStopped,
	KEEPALIVE_DELAY_SECONDS,
	keepaliveEnabled,
} from "../../extensions/background/wakeup.ts";

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 25, h, m, s).getTime();
const newLoop = () => {
	const store = new CronStore({ jitter: false });
	return { store, loop: new DynamicLoop(store) };
};

describe("DynamicLoop (Claude Code's loop core, 2.1.282)", () => {
	it("stores a wakeup as a one-shot job naming its minute, firing at the exact time", () => {
		const { store, loop } = newLoop();
		const scheduled = loop.schedule(90, "poll", at(14, 3, 20));
		expect(scheduled).toEqual({ scheduledFor: at(14, 4, 50), clampedDelaySeconds: 90, wasClamped: false });
		expect(store.list()).toMatchObject([{ cron: "4 14 * * *", recurring: false, source: "wakeup", nextFireAt: at(14, 4, 50) }]);
	});

	it("reports a delay outside [60, 3600] as clamped", () => {
		const { loop } = newLoop();
		expect(loop.schedule(4000, "p", at(12, 0))).toMatchObject({ clampedDelaySeconds: 3600, wasClamped: true });
		expect(loop.schedule(60, "p", at(12, 0))).toMatchObject({ wasClamped: false });
	});

	it("keeps one wakeup pending; stop cancels it and counts it", () => {
		const { store, loop } = newLoop();
		loop.schedule(60, "a", at(12, 0));
		loop.schedule(60, "b", at(12, 0));
		expect(store.list().map((j) => j.prompt)).toEqual(["b"]);
		expect(loop.stop()).toBe(1);
		expect(loop.stop()).toBe(0);
	});

	it("ends a loop whose prompt has run for 7 days, and restarts the age after an hour's gap", () => {
		const { loop } = newLoop();
		const day = 86_400_000;
		let now = at(12, 0);
		// Reschedule every 30 minutes for a week.
		while (now - at(12, 0) < 7 * day) {
			expect(loop.schedule(1800, "tick", now)).not.toBeNull();
			now += 1_800_000;
		}
		expect(loop.schedule(1800, "tick", now)).toBeNull();
		// A different prompt is a different loop.
		expect(loop.schedule(1800, "other", now)).not.toBeNull();
	});

	it("stop forgets the age of the prompts it cancels and the one in flight, so a restart starts a new loop", () => {
		const min = 60_000;
		const store = new CronStore({ jitter: false });
		const loop = new DynamicLoop(store, 120 * min);
		const start = at(12, 0);
		const runFor = (prompt: string) => {
			for (let t = 0; t <= 90; t += 30) loop.schedule(1800, prompt, start + t * min);
		};
		// A pending wakeup's prompt: without the reset, the restart would keep
		// the old start and age out at 12:00 + 2 h.
		runFor("pending");
		loop.stop();
		loop.schedule(1800, "pending", start + 100 * min);
		expect(loop.schedule(1800, "pending", start + 130 * min)).not.toBeNull();

		// The prompt whose tick is running (its wakeup already fired).
		runFor("running");
		store.deleteWhere((job) => job.prompt === "running");
		loop.inFlight = "running";
		loop.stop();
		loop.schedule(1800, "running", start + 100 * min);
		expect(loop.schedule(1800, "running", start + 130 * min)).not.toBeNull();
	});

	it("keepalive: one fallback after a wakeup turn that scheduled nothing, then the loop ends", () => {
		const { store, loop } = newLoop();
		loop.inFlight = "tick";
		expect(loop.settle(at(12, 0), true)).toBe("armed");
		expect(store.list()[0]).toMatchObject({ prompt: "tick", nextFireAt: at(12, 0) + KEEPALIVE_DELAY_SECONDS * 1000 });
		store.clear();
		loop.inFlight = "tick";
		expect(loop.settle(at(12, 30), true)).toBe("ended");
		expect(store.size).toBe(0);
	});

	it("keepalive stays out of a turn that scheduled its own wakeup, and resets when the model schedules", () => {
		const { store, loop } = newLoop();
		loop.inFlight = "tick";
		loop.schedule(600, "tick", at(12, 0));
		expect(loop.settle(at(12, 1), true)).toBe("none");
		store.clear();
		loop.inFlight = "tick";
		expect(loop.settle(at(12, 20), true)).toBe("armed");
		loop.schedule(600, "tick", at(12, 21)); // the model schedules again: the budget resets
		store.clear();
		loop.inFlight = "tick";
		expect(loop.settle(at(12, 40), true)).toBe("armed");
	});

	it("a turn that ran no wakeup is none of the keepalive's business", () => {
		const { loop } = newLoop();
		expect(loop.settle(at(12, 0), true)).toBe("none");
	});
});

describe("schedule_wakeup texts", () => {
	it("formats the scheduled result in local time", () => {
		expect(formatScheduled({ scheduledFor: at(14, 5, 9), clampedDelaySeconds: 300, wasClamped: false }, at(14, 0, 9))).toBe(
			"Next wakeup scheduled for 14:05:09 (in 300s). Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.",
		);
	});

	it("names our tools in the stop texts", () => {
		expect(formatStopped(0)).toContain("cancel it with cron_delete. If you armed a monitor for this loop, task_stop it now;");
		expect(formatStopped(2)).toContain("cancelled 2 pending wakeup(s)");
		expect(AGED_OUT_RESULT).toBe("Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue.");
	});

	it("turns keepalive off only for a false-like CLAUDE_CODE_LOOP_KEEPALIVE", () => {
		expect(keepaliveEnabled({})).toBe(true);
		expect(keepaliveEnabled({ CLAUDE_CODE_LOOP_KEEPALIVE: "0" })).toBe(false);
		expect(keepaliveEnabled({ CLAUDE_CODE_LOOP_KEEPALIVE: "false" })).toBe(false);
		expect(keepaliveEnabled({ CLAUDE_CODE_LOOP_KEEPALIVE: "1" })).toBe(true);
	});
});
