import { describe, expect, it } from "vitest";
import {
	batchSize,
	emptyBatch,
	formatMonitorEvents,
	MONITOR_BATCH_MAX_CHARS,
	MONITOR_BATCH_MAX_LINES,
	MONITOR_MAX_LINE_CHARS,
	MonitorLineSplitter,
	pushEvent,
} from "../../extensions/background/monitor-batch.ts";

describe("monitor batching", () => {
	it("keeps at most MAX_LINES lines and counts the rest", () => {
		const batch = emptyBatch();
		for (let i = 0; i < MONITOR_BATCH_MAX_LINES + 25; i++) pushEvent(batch, `line ${i}`);
		expect(batch.shown).toHaveLength(MONITOR_BATCH_MAX_LINES);
		expect(batch.overflow).toBe(25);
		expect(batchSize(batch)).toBe(MONITOR_BATCH_MAX_LINES + 25);
		const text = formatMonitorEvents("m1", batch);
		expect(text).toContain("+25 more line(s) not shown — task_output m1 has the full stream");
		expect(text.split("\n")).toHaveLength(MONITOR_BATCH_MAX_LINES + 1);
	});

	it("caps the characters shown and reports the lines it dropped", () => {
		const batch = emptyBatch();
		for (let i = 0; i < 10; i++) pushEvent(batch, "x".repeat(1_000));
		const text = formatMonitorEvents("m2", batch);
		expect(text.length).toBeLessThan(MONITOR_BATCH_MAX_CHARS + 300);
		expect(text).toMatch(/\+\d+ more line\(s\) not shown/);
	});

	it("shows a small batch in full with no overflow note", () => {
		const batch = emptyBatch();
		pushEvent(batch, "a");
		pushEvent(batch, "b");
		expect(formatMonitorEvents("m3", batch)).toBe("a\nb");
	});
});

describe("MonitorLineSplitter (A3-M2)", () => {
	it("returns complete lines as they arrive and the unterminated last line at end", () => {
		const lines = new MonitorLineSplitter();
		expect(lines.push("first\nRE")).toEqual(["first"]);
		expect(lines.push("ADY")).toEqual([]);
		expect(lines.end()).toEqual(["READY"]);
		expect(lines.end()).toEqual([]);
	});

	it("keeps only the latest carriage-return segment, so a progress meter never grows the buffer", () => {
		const lines = new MonitorLineSplitter();
		for (let i = 0; i < 10_000; i++) expect(lines.push(`\r${i}% done`)).toEqual([]);
		expect(lines.push("\r100% done\n")).toEqual(["100% done"]);
		// A CRLF split across chunks keeps the text before it.
		expect(lines.push("READY\r")).toEqual([]);
		expect(lines.push("\n")).toEqual(["READY"]);
	});

	it("sends a line longer than the cap at the cap instead of holding it", () => {
		const lines = new MonitorLineSplitter();
		const out = lines.push("x".repeat(MONITOR_MAX_LINE_CHARS + 1));
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(MONITOR_MAX_LINE_CHARS + 1);
		expect(lines.end()).toEqual([]);
	});
});
