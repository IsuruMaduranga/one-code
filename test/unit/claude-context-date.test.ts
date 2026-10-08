/**
 * The date reminder carries the user's local date, and a session that crosses
 * local midnight hears of the new date as a one-shot, so the frozen reminder on
 * message 1 never changes mid-session.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { dateChangeReminder, localDate } from "../../extensions/lib/claude-context.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { DATE_CHANGE_KEY } from "../../extensions/lib/context-facts.ts";
import { CONTEXT_FACTS_REFRESH_CHANNEL, type ContextFactsRefresh } from "../../extensions/lib/context-stack.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

describe("localDate", () => {
	const originalTz = process.env.TZ;
	afterEach(() => {
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	it("is the calendar date of the user's own clock, not UTC's", () => {
		// 20:00 UTC on 26 September is already 27 September in Colombo (UTC+5:30)
		// and still 26 September in Los Angeles.
		const instant = new Date("2026-09-26T20:00:00Z");
		process.env.TZ = "Asia/Colombo";
		expect(localDate(instant)).toBe("2026-09-27");
		process.env.TZ = "America/Los_Angeles";
		expect(localDate(instant)).toBe("2026-09-26");
		process.env.TZ = "America/Los_Angeles";
		expect(localDate(new Date("2026-09-27T02:00:00Z"))).toBe("2026-09-26");
	});
});

describe("claude-context date wiring", () => {
	let fake: FakePi;
	let dir: string;
	const reminders: Array<{ key?: string; text?: string; placement?: string; scope?: string }> = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claude-context-date-"));
		stubHome(dir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, ".claude"));
		writeFileSync(join(dir, "CLAUDE.md"), "Project rules.\n");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 8, 26, 23, 50));
		fake = createFakePi();
		reminders.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		claudeContextExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	const block = () => reminders.filter((r) => r.key === "claude-context-date");
	/** Everything but the instructions block, which session_start queues once. */
	const datesAndNotices = () => reminders.filter((r) => r.key !== "claude-context");

	it("stamps the local date and announces a date change as a one-shot, leaving the block alone", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: dir }));
		expect(block()).toHaveLength(1);
		expect(block()[0].text).toBe("Today's date is 2026-09-26.");
		expect(reminders.find((r) => r.key === "claude-context")?.text).toContain("Project rules.");

		// Same day: nothing more.
		await fake.fireOne("before_agent_start", {}, createFakeCtx({ cwd: dir }));
		expect(datesAndNotices()).toHaveLength(1);

		// Past local midnight: one one-shot, the block untouched.
		vi.setSystemTime(new Date(2026, 8, 27, 0, 10));
		await fake.fireOne("before_agent_start", {}, createFakeCtx({ cwd: dir }));
		expect(block()).toHaveLength(1);
		const notices = reminders.filter((r) => r.key === DATE_CHANGE_KEY);
		expect(notices).toEqual([{ key: DATE_CHANGE_KEY, text: dateChangeReminder("2026-09-27") }]);
		expect(notices[0].text).toBe(
			"The date has changed. Today's date is now 2026-09-27. No need to announce the new date — the user's own clock shows it.",
		);

		// Announced once, not on every later turn.
		await fake.fireOne("before_agent_start", {}, createFakeCtx({ cwd: dir }));
		expect(datesAndNotices()).toHaveLength(2);
	});

	it("silently refreshes the date with the rest of the facts after compaction", async () => {
		const refreshes: ContextFactsRefresh[] = [];
		fake.events.on(CONTEXT_FACTS_REFRESH_CHANNEL, (data) => refreshes.push(data as ContextFactsRefresh));
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: dir }));
		vi.setSystemTime(new Date(2026, 8, 27, 0, 10));
		await fake.fireOne("session_compact", {}, createFakeCtx({ cwd: dir }));
		expect(refreshes[0].entries.find((entry) => entry.key === "claude-context-date")?.text).toBe("Today's date is 2026-09-27.");
		await fake.fireOne("before_agent_start", {}, createFakeCtx({ cwd: dir }));
		expect(reminders.filter((r) => r.key === DATE_CHANGE_KEY)).toHaveLength(0);
	});
});
