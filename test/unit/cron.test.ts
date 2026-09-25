import { afterAll, describe, expect, it } from "vitest";
import {
	clipPrompt,
	CronStore,
	jitterFraction,
	nextRecurringFire,
	oneShotFire,
	describeCadence,
	formatCreateResult,
	formatDeleteResult,
	formatJobList,
	formatUnknownJob,
	MAX_JOBS,
	nextMatch,
	parseCron,
	RECURRING_MAX_AGE_MS,
} from "../../extensions/background/cron.ts";

// Local-time semantics are the point of these tests, so pin a zone with DST
// before any Date is built (describe bodies run at collection time).
const originalTz = process.env.TZ;
process.env.TZ = "America/New_York";
afterAll(() => {
	if (originalTz === undefined) delete process.env.TZ;
	else process.env.TZ = originalTz;
});

/** A local-time Date; month is 1-based for readability. */
function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
	return new Date(y, mo - 1, d, h, mi);
}

function next(expr: string, from: Date): Date | null {
	const fields = parseCron(expr);
	if (!fields) throw new Error(`bad expr ${expr}`);
	return nextMatch(fields, from);
}

describe("parseCron", () => {
	it("expands stars, steps, ranges, stepped ranges and lists", () => {
		expect(parseCron("*/15 9-17 1,15 */3 1-5")).toEqual({
			minute: [0, 15, 30, 45],
			hour: [9, 10, 11, 12, 13, 14, 15, 16, 17],
			dayOfMonth: [1, 15],
			month: [1, 4, 7, 10],
			dayOfWeek: [1, 2, 3, 4, 5],
		});
		expect(parseCron("0-30/10 * * * *")?.minute).toEqual([0, 10, 20, 30]);
	});

	it("reads day-of-week 7 as Sunday, alone or at the top of a range", () => {
		expect(parseCron("0 9 * * 7")?.dayOfWeek).toEqual([0]);
		expect(parseCron("0 9 * * 5-7")?.dayOfWeek).toEqual([0, 5, 6]);
	});

	it("tolerates surrounding and repeated whitespace", () => {
		expect(parseCron("  */5   *  * * *  ")?.minute).toHaveLength(12);
	});

	it("rejects malformed expressions", () => {
		for (const bad of [
			"* * * *", // 4 fields
			"* * * * * *", // 6 fields
			"60 * * * *", // minute out of range
			"* 24 * * *",
			"* * 0 * *",
			"* * * 13 *",
			"* * * * 8",
			"*/0 * * * *", // zero step
			"5/2 * * * *", // a stepped single value is not supported
			"10-5 * * * *", // inverted range
			"1,,2 * * * *", // empty list item
			"0 9 * * MON", // names are not supported
			"0 9 * JAN *",
			"",
		]) {
			expect(parseCron(bad), bad).toBeNull();
		}
	});
});

describe("nextMatch", () => {
	it("returns the first matching minute strictly after `from`, at second zero", () => {
		const from = new Date(local(2026, 9, 24, 10, 5).getTime() + 30_000);
		expect(next("*/5 * * * *", from)).toEqual(local(2026, 9, 24, 10, 10));
		expect(next("* * * * *", local(2026, 9, 24, 10, 5))).toEqual(local(2026, 9, 24, 10, 6));
	});

	it("gives */7 its short gap at the hour boundary, like cron", () => {
		expect(next("*/7 * * * *", local(2026, 9, 24, 10, 56))).toEqual(local(2026, 9, 24, 11, 0));
	});

	it("ORs day-of-month and day-of-week when both are restricted", () => {
		// Thursday 2026-09-24: the next Friday (25th) comes before the 13th.
		expect(next("0 9 13 * 5", local(2026, 9, 24, 12))).toEqual(local(2026, 9, 25, 9));
		// Friday 2026-11-13 matches both fields; the Friday before it matches one.
		expect(next("0 9 13 * 5", local(2026, 11, 7))).toEqual(local(2026, 11, 13, 9));
		expect(next("0 9 13 * 1", local(2026, 11, 10))).toEqual(local(2026, 11, 13, 9));
	});

	it("treats a full day-of-month list as unrestricted, so only day-of-week counts", () => {
		expect(next("0 9 1-31 * 1", local(2026, 9, 24))).toEqual(local(2026, 9, 28, 9));
	});

	it("skips months that cannot match", () => {
		expect(next("0 0 29 2 *", local(2026, 9, 24))).toEqual(local(2028, 2, 29));
		expect(next("3 9 28 12 *", local(2026, 9, 24))).toEqual(local(2026, 12, 28, 9, 3));
	});

	it("returns null when nothing matches within a year", () => {
		expect(next("0 0 30 2 *", local(2026, 9, 24))).toBeNull();
		expect(next("0 0 31 4 *", local(2026, 9, 24))).toBeNull();
	});

	it("skips a time that does not exist on a spring-forward day", () => {
		// 2026-03-08: New York clocks jump from 2:00 to 3:00.
		const hit = next("30 2 * * *", local(2026, 3, 7, 23));
		expect(hit).not.toBeNull();
		expect(hit!.getTime()).toBeGreaterThan(local(2026, 3, 7, 23).getTime());
		expect([hit!.getHours(), hit!.getMinutes()]).toEqual([2, 30]);
		expect(hit!.getDate()).toBe(9);
	});

	it("matches a repeated hour on a fall-back day once", () => {
		// 2026-11-01: New York repeats 1:00–1:59; the job fires on the first pass only.
		const first = next("30 1 * * *", local(2026, 11, 1));
		expect([first!.getDate(), first!.getHours(), first!.getMinutes()]).toEqual([1, 1, 30]);
		const second = next("30 1 * * *", first!);
		expect([second!.getDate(), second!.getHours(), second!.getMinutes()]).toEqual([2, 1, 30]);
		expect(second!.getTime() - first!.getTime()).toBe(25 * 60 * 60 * 1000);
	});
});

describe("describeCadence", () => {
	it("names Claude Code's recognised shapes", () => {
		expect(describeCadence("* * * * *")).toBe("Every minute");
		expect(describeCadence("*/1 * * * *")).toBe("Every minute");
		expect(describeCadence("*/7 * * * *")).toBe("Every 7 minutes");
		expect(describeCadence("0 * * * *")).toBe("Every hour");
		expect(describeCadence("7 * * * *")).toBe("Every hour at :07");
		expect(describeCadence("0 */2 * * *")).toBe("Every 2 hours");
		expect(describeCadence("15 */1 * * *")).toBe("Every hour at :15");
		expect(describeCadence("15 */3 * * *")).toBe("Every 3 hours at :15");
		expect(describeCadence("57 8 * * *")).toMatch(/^Every day at 8:57\sAM$/);
		expect(describeCadence("30 14 * * 3")).toMatch(/^Every Wednesday at 2:30\sPM$/);
		expect(describeCadence("0 9 * * 7")).toMatch(/^Every Sunday at 9:00\sAM$/);
		expect(describeCadence("3 9 * * 1-5")).toMatch(/^Weekdays at 9:03\sAM$/);
	});

	it("falls back to the raw expression", () => {
		expect(describeCadence("3 9 28 12 *")).toBe("3 9 28 12 *");
		expect(describeCadence("*/5 9-17 * * *")).toBe("*/5 9-17 * * *");
		expect(describeCadence("0 9 * * 1,3")).toBe("0 9 * * 1,3");
		expect(describeCadence("bogus")).toBe("bogus");
	});
});

describe("CronStore", () => {
	const now = local(2026, 9, 24, 10, 0).getTime();
	const ids = (...list: string[]) => {
		let i = 0;
		return () => list[i++] ?? `id${i}`;
	};

	it("creates recurring jobs by default and lists them in creation order", () => {
		const store = new CronStore({ jitter: false, newId: ids("aaaa1111", "bbbb2222") });
		const a = store.create({ cron: "*/5 * * * *", prompt: "ping" }, now);
		const b = store.create({ cron: "3 9 28 12 *", prompt: "remind", recurring: false }, now);
		expect(a).toMatchObject({ ok: true, job: { id: "aaaa1111", recurring: true, source: "model", nextFireAt: local(2026, 9, 24, 10, 5).getTime() } });
		expect(b).toMatchObject({ ok: true, job: { id: "bbbb2222", recurring: false } });
		expect(store.list().map((j) => j.id)).toEqual(["aaaa1111", "bbbb2222"]);
		expect(store.list()[0]).not.toHaveProperty("fields");
	});

	it("uses the first 8 hex characters of a UUID as the default id", () => {
		const res = new CronStore({ jitter: false }).create({ cron: "* * * * *", prompt: "x" }, now);
		expect(res.ok && res.job.id).toMatch(/^[0-9a-f]{8}$/);
	});

	it("draws a new id on collision", () => {
		const store = new CronStore({ jitter: false, newId: ids("same0000", "same0000", "other000") });
		store.create({ cron: "* * * * *", prompt: "x" }, now);
		const second = store.create({ cron: "* * * * *", prompt: "y" }, now);
		expect(second.ok && second.job.id).toBe("other000");
	});

	it("rejects with Claude Code's wording", () => {
		const store = new CronStore({ jitter: false, maxJobs: 1 });
		expect(store.create({ cron: "* * *", prompt: "x" }, now)).toEqual({
			ok: false,
			error: "Invalid cron expression '* * *'. Expected 5 fields: M H DoM Mon DoW.",
		});
		expect(store.create({ cron: "0 0 30 2 *", prompt: "x" }, now)).toEqual({
			ok: false,
			error: "Cron expression '0 0 30 2 *' does not match any calendar date in the next year.",
		});
		store.create({ cron: "* * * * *", prompt: "x" }, now);
		expect(store.create({ cron: "* * * * *", prompt: "y" }, now)).toEqual({
			ok: false,
			error: "Too many scheduled jobs (max 1). Cancel one first.",
		});
	});

	it("caps a session at 50 jobs by default", () => {
		const store = new CronStore({ jitter: false });
		for (let i = 0; i < MAX_JOBS; i++) expect(store.create({ cron: "* * * * *", prompt: `${i}` }, now).ok).toBe(true);
		expect(store.create({ cron: "* * * * *", prompt: "one more" }, now).ok).toBe(false);
	});

	it("reports the earliest pending fire", () => {
		const store = new CronStore({ jitter: false });
		expect(store.nextFireAt()).toBeUndefined();
		store.create({ cron: "0 12 * * *", prompt: "noon" }, now);
		store.create({ cron: "*/15 * * * *", prompt: "quarter" }, now);
		expect(store.nextFireAt()).toBe(local(2026, 9, 24, 10, 15).getTime());
	});

	it("fires nothing before a job is due", () => {
		const store = new CronStore({ jitter: false });
		store.create({ cron: "*/5 * * * *", prompt: "ping" }, now);
		expect(store.takeDue(now + 4 * 60_000)).toEqual([]);
	});

	it("fires a recurring job once and re-arms it past `now`", () => {
		const store = new CronStore({ jitter: false, newId: ids("r0000000") });
		store.create({ cron: "*/5 * * * *", prompt: "ping" }, now);
		const at = local(2026, 9, 24, 10, 5).getTime();
		expect(store.takeDue(at)).toEqual([{ job: expect.objectContaining({ id: "r0000000", prompt: "ping" }), final: false }]);
		expect(store.get("r0000000")?.nextFireAt).toBe(local(2026, 9, 24, 10, 10).getTime());
	});

	it("collapses matches missed during a long turn into one fire", () => {
		const store = new CronStore({ jitter: false });
		store.create({ cron: "* * * * *", prompt: "tick" }, now);
		const late = now + 17 * 60_000 + 20_000;
		expect(store.takeDue(late)).toHaveLength(1);
		expect(store.nextFireAt()).toBe(now + 18 * 60_000);
		expect(store.takeDue(late)).toEqual([]);
	});

	it("deletes a one-shot job when it fires", () => {
		const store = new CronStore({ jitter: false, newId: ids("once0000") });
		store.create({ cron: "30 10 24 9 *", prompt: "remind", recurring: false }, now);
		expect(store.takeDue(local(2026, 9, 24, 10, 30).getTime())).toEqual([{ job: expect.objectContaining({ id: "once0000" }), final: true }]);
		expect(store.size).toBe(0);
	});

	it("gives a recurring job past its 7-day age one final fire", () => {
		const store = new CronStore({ jitter: false });
		store.create({ cron: "7 * * * *", prompt: "hourly" }, now);
		const beforeExpiry = now + RECURRING_MAX_AGE_MS - 53 * 60_000; // an :07 a little under 7 days in
		expect(store.takeDue(beforeExpiry)[0].final).toBe(false);
		const afterExpiry = now + RECURRING_MAX_AGE_MS + 7 * 60_000;
		expect(store.takeDue(afterExpiry)).toEqual([{ job: expect.anything(), final: true }]);
		expect(store.size).toBe(0);
	});

	it("deletes by id and by predicate", () => {
		const store = new CronStore({ jitter: false, newId: ids("m0000000", "l0000000", "l1111111") });
		store.create({ cron: "* * * * *", prompt: "model" }, now);
		store.create({ cron: "* * * * *", prompt: "wake a", source: "wakeup" }, now);
		store.create({ cron: "* * * * *", prompt: "wake b", source: "wakeup" }, now);
		expect(store.delete("nope")).toBe(false);
		expect(store.deleteWhere((j) => j.source === "wakeup").map((j) => j.id)).toEqual(["l0000000", "l1111111"]);
		expect(store.delete("m0000000")).toBe(true);
		expect(store.size).toBe(0);
	});
});

describe("model-facing text", () => {
	const job = { id: "2427a4e2", cron: "*/7 * * * *", prompt: "Say the word ping.", recurring: true, source: "model" as const, createdAt: 0, nextFireAt: 0 };

	it("matches Claude Code's result strings with our tool names", () => {
		expect(formatCreateResult(job)).toBe(
			"Scheduled recurring job 2427a4e2 (Every 7 minutes). Session-only (not written to disk, dies when this session ends). Auto-expires after 7 days. Use cron_delete to cancel sooner.",
		);
		expect(formatCreateResult({ ...job, id: "8a527832", cron: "3 9 28 12 *", recurring: false })).toBe(
			"Scheduled one-shot task 8a527832 (3 9 28 12 *). Session-only (not written to disk, dies when this session ends). It will fire once then auto-delete.",
		);
		expect(formatJobList([job, { ...job, id: "8a527832", cron: "3 9 28 12 *", recurring: false, prompt: "One-shot test" }])).toBe(
			"2427a4e2 — Every 7 minutes (recurring) [session-only]: Say the word ping.\n8a527832 — 3 9 28 12 * (one-shot) [session-only]: One-shot test",
		);
		expect(formatJobList([])).toBe("No scheduled jobs.");
		expect(formatDeleteResult("2427a4e2")).toBe("Cancelled job 2427a4e2.");
		expect(formatUnknownJob("nope")).toBe("No scheduled job with id 'nope'");
	});
});

describe("Claude Code's jitter (2.1.282 code, not its description)", () => {
	const at = (h: number, m: number, sec = 0) => new Date(2026, 8, 25, h, m, sec).getTime();

	it("derives a fixed fraction from the id's first 8 hex digits", () => {
		expect(jitterFraction("00000000")).toBe(0);
		expect(jitterFraction("80000000")).toBe(0.5);
		expect(jitterFraction("zzzzzzzz")).toBe(0);
	});

	it("fires a recurring job up to half its period late, capped at 30 minutes", () => {
		const hourly = parseCron("7 * * * *")!;
		// fraction 0.5 → 0.5 × 0.5 × 60 min = 15 min late.
		expect(nextRecurringFire("7 * * * *", hourly, at(12, 0), "80000000")).toBe(at(12, 22));
		const daily = parseCron("3 9 * * *")!;
		// 0.25 of a day would be 6 h; the cap holds it at 30 min.
		expect(nextRecurringFire("3 9 * * *", daily, at(8, 0), "80000000")).toBe(at(9, 33));
	});

	it("fires a plain every-5-minutes job 15 s before its period ends, from the last fire", () => {
		const five = parseCron("*/5 * * * *")!;
		expect(nextRecurringFire("*/5 * * * *", five, at(12, 1, 10), "ffffffff")).toBe(at(12, 5, 55));
		// Not for */10, nor for a list that happens to be 5 minutes apart.
		expect(nextRecurringFire("*/10 * * * *", parseCron("*/10 * * * *")!, at(12, 1), "00000000")).toBe(at(12, 10));
	});

	it("fires a one-shot on :00 or :30 up to 90 s early, never before it was made", () => {
		const half = parseCron("30 14 25 9 *")!;
		expect(oneShotFire(half, at(14, 0), "80000000")).toBe(at(14, 29, 15));
		expect(oneShotFire(half, at(14, 29, 50), "ffffffff")).toBe(at(14, 29, 50));
		const odd = parseCron("31 14 25 9 *")!;
		expect(oneShotFire(odd, at(14, 0), "ffffffff")).toBe(at(14, 31));
	});

	it("applies it in the store by default", () => {
		const store = new CronStore({ newId: () => "80000000" });
		const created = store.create({ cron: "7 * * * *", prompt: "x" }, at(12, 0));
		expect(created.ok && created.job.nextFireAt).toBe(at(12, 22));
	});
});

describe("clipPrompt (CronList's 80-column clip)", () => {
	it("keeps a short single line, cuts a long one to 79 columns plus an ellipsis", () => {
		expect(clipPrompt("check the build")).toBe("check the build");
		const long = "x".repeat(100);
		expect(clipPrompt(long)).toBe(`${"x".repeat(79)}…`);
		expect(clipPrompt("x".repeat(80))).toBe("x".repeat(80));
	});

	it("shows only the first line of a multi-line prompt, always marked", () => {
		expect(clipPrompt("first\nsecond")).toBe("first…");
		expect(clipPrompt(`${"y".repeat(90)}\nmore`)).toBe(`${"y".repeat(79)}…`);
	});

	it("measures terminal columns, not code units", () => {
		expect(clipPrompt("界".repeat(50))).toBe(`${"界".repeat(39)}…`);
	});
});
