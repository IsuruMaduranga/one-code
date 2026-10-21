/**
 * Scheduled jobs survive /reload (design.md section 13, answer 5): the process
 * keeps running, so the session's crons and wakeups come back from the branch.
 */
import { describe, expect, it } from "vitest";
import { CronStore, scheduledJobsOnBranch } from "../../extensions/background/cron.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (toolCallId: string, toolName: string, details: Record<string, unknown>, timestamp = 1_000) => ({ type: "message", message: { role: "toolResult", toolCallId, toolName, content: [], details, timestamp } });
const fire = (customType: "cron" | "wakeup", jobId: string, final: boolean) => ({ type: "custom_message", customType, details: { jobId, final } });

describe("scheduledJobsOnBranch", () => {
	it("keeps created crons with their prompts, minus deletes and final fires", () => {
		const branch = [
			call("c1", "cron_create", { cron: "*/5 * * * *", prompt: "check the build" }),
			result("c1", "cron_create", { jobId: "j1", cron: "*/5 * * * *", recurring: true }),
			call("c2", "cron_create", { cron: "0 9 * * *", prompt: "standup", recurring: false }),
			result("c2", "cron_create", { jobId: "j2", cron: "0 9 * * *", recurring: false }),
			call("c3", "cron_create", { cron: "0 * * * *", prompt: "gone" }),
			result("c3", "cron_create", { jobId: "j3", cron: "0 * * * *", recurring: true }),
			call("c4", "cron_delete", { id: "j3" }),
			result("c4", "cron_delete", { jobId: "j3" }),
			fire("cron", "j2", true),
			fire("cron", "j1", false),
		];
		expect(scheduledJobsOnBranch(branch)).toEqual([{ id: "j1", cron: "*/5 * * * *", prompt: "check the build", recurring: true, source: "model", createdAt: 1_000 }]);
	});

	it("keeps only the latest wakeup, until it fires or the loop stops", () => {
		const wakeup = (id: string, prompt: string, scheduledFor: number) => [call(id, "schedule_wakeup", { delaySeconds: 60, prompt, reason: "r", noop: false }), result(id, "schedule_wakeup", { scheduledFor })];
		const scheduled = [...wakeup("w1", "first", 61_000), ...wakeup("w2", "second", 121_000)];
		expect(scheduledJobsOnBranch(scheduled).map((job) => [job.prompt, job.fireAt])).toEqual([["second", 121_000]]);
		expect(scheduledJobsOnBranch([...scheduled, fire("wakeup", "x", true)])).toEqual([]);
		expect(scheduledJobsOnBranch([...scheduled, call("s", "schedule_wakeup", { stop: true }), result("s", "schedule_wakeup", { stopped: true })])).toEqual([]);
	});
});

describe("CronStore.restore", () => {
	it("re-arms a job under its own id, and drops a recurring one past its age", () => {
		const store = new CronStore({ jitter: false, maxAgeMs: 10_000 });
		const now = Date.parse("2026-10-21T10:02:00");
		expect(store.restore({ id: "j1", cron: "*/5 * * * *", prompt: "p", recurring: true, source: "model", createdAt: now - 1_000 }, now)).toBe(true);
		expect(store.get("j1")?.nextFireAt).toBe(Date.parse("2026-10-21T10:05:00"));
		expect(store.restore({ id: "old", cron: "*/5 * * * *", prompt: "p", recurring: true, source: "model", createdAt: now - 20_000 }, now)).toBe(false);
		expect(store.restore({ id: "w", cron: "3 10 * * *", prompt: "wake", recurring: false, source: "wakeup", createdAt: now, fireAt: now + 60_000 }, now)).toBe(true);
		expect(store.get("w")?.nextFireAt).toBe(now + 60_000);
	});

	it("makes a fire missed during the reload due at once, counting from the job's last fire on the branch", () => {
		const store = new CronStore({ jitter: false, maxAgeMs: 3_600_000 });
		const now = Date.parse("2026-10-21T10:07:00");
		// Created at 9:58, last fired at 10:00; the 10:05 fire fell during the reload.
		store.restore({ id: "j1", cron: "*/5 * * * *", prompt: "p", recurring: true, source: "model", createdAt: Date.parse("2026-10-21T09:58:00"), lastFiredAt: Date.parse("2026-10-21T10:00:00") }, now);
		expect(store.get("j1")?.nextFireAt).toBe(Date.parse("2026-10-21T10:05:00"));
		// A one-shot due during the reload.
		store.restore({ id: "j2", cron: "6 10 21 10 *", prompt: "once", recurring: false, source: "model", createdAt: Date.parse("2026-10-21T10:01:00") }, now);
		expect(store.get("j2")?.nextFireAt).toBe(Date.parse("2026-10-21T10:06:00"));
	});

	it("reads a recurring job's last fire from the branch", () => {
		const branch = [
			call("c1", "cron_create", { cron: "*/5 * * * *", prompt: "check the build" }),
			result("c1", "cron_create", { jobId: "j1", cron: "*/5 * * * *", recurring: true }),
			{ ...fire("cron", "j1", false), timestamp: "2026-10-21T10:00:00.000Z" },
		];
		expect(scheduledJobsOnBranch(branch)[0]?.lastFiredAt).toBe(Date.parse("2026-10-21T10:00:00.000Z"));
	});
});
