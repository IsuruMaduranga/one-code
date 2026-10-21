/**
 * The date reminder carries the user's local date, and a session that crosses
 * local midnight hears of the new date on a request's tail, decided from the
 * date its epoch told, so message 1 never changes inside an epoch.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { dateChangeReminder, localDate } from "../../extensions/lib/claude-context.ts";
import { REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest } from "../../extensions/lib/reminders.ts";
import { dateFingerprint, FACT_KEYS } from "../../extensions/lib/context-facts.ts";
import { createFakeCtx, createFakePi, type FakePi, renderRequest } from "./helpers/fake-pi.ts";
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
	/** Render a request inside an epoch whose message 1 told `toldDate`; the texts claude-context adds. */
	const render = (toldDate: string) => {
		return renderRequest(fake.events, { facts: [{ kind: "block", key: FACT_KEYS.date, hash: dateFingerprint(toldDate) }] });
	};

	it("stamps the local date, with the date it tells as a fact", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: dir }));
		expect(block()).toHaveLength(1);
		expect(block()[0]).toMatchObject({ text: "Today's date is 2026-09-26.", facts: [{ kind: "block", key: FACT_KEYS.date, hash: dateFingerprint("2026-09-26") }] });
		expect(reminders.find((r) => r.key === "claude-context")?.text).toContain("Project rules.");
	});

	it("announces a date change on the tail once the epoch told an older date, and only then", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: dir }));
		// Same day: nothing.
		expect(render("2026-09-26")).toEqual([]);
		// Past local midnight: one notice, telling the new date.
		vi.setSystemTime(new Date(2026, 8, 27, 0, 10));
		const blocks = render("2026-09-26");
		expect(blocks).toEqual([{ text: dateChangeReminder("2026-09-27"), facts: [{ kind: "block", key: FACT_KEYS.date, hash: dateFingerprint("2026-09-27") }] }]);
		expect(blocks[0].text).toBe("The date has changed. Today's date is now 2026-09-27. No need to announce the new date — the user's own clock shows it.");
		// Once told, not again; and the live block now says the new date, for a later epoch's message 1.
		expect(render("2026-09-27")).toEqual([]);
		expect(block()).toHaveLength(2);
		expect(block().at(-1)?.text).toContain("2026-09-27");
	});

	it("refreshes the live date block at a compaction, for the epoch it opens", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: dir }));
		vi.setSystemTime(new Date(2026, 8, 27, 0, 10));
		await fake.fireOne("session_compact", {}, createFakeCtx({ cwd: dir, sessionManager: { getBranch: () => [] } }));
		expect(block().at(-1)?.text).toBe("Today's date is 2026-09-27.");
	});
});
