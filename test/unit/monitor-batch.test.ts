import { describe, expect, it } from "vitest";
import {
	batchSize,
	emptyBatch,
	formatMonitorBatch,
	MONITOR_BATCH_MAX_CHARS,
	MONITOR_BATCH_MAX_LINES,
	pushEvent,
} from "../../extensions/background/monitor-batch.ts";

describe("monitor batching", () => {
	it("keeps at most MAX_LINES lines and counts the rest", () => {
		const batch = emptyBatch();
		for (let i = 0; i < MONITOR_BATCH_MAX_LINES + 25; i++) pushEvent(batch, `line ${i}`);
		expect(batch.shown).toHaveLength(MONITOR_BATCH_MAX_LINES);
		expect(batch.overflow).toBe(25);
		expect(batchSize(batch)).toBe(MONITOR_BATCH_MAX_LINES + 25);
		const text = formatMonitorBatch("m1", "log", batch);
		expect(text).toContain(`emitted ${MONITOR_BATCH_MAX_LINES + 25} event(s)`);
		expect(text).toContain("+25 more line(s) not shown — task_output m1 has the full stream");
		expect(text.split("\n")).toHaveLength(1 + MONITOR_BATCH_MAX_LINES + 1);
	});

	it("caps the characters shown and reports the lines it dropped", () => {
		const batch = emptyBatch();
		for (let i = 0; i < 10; i++) pushEvent(batch, "x".repeat(1_000));
		const text = formatMonitorBatch("m2", "log", batch);
		expect(text.length).toBeLessThan(MONITOR_BATCH_MAX_CHARS + 300);
		expect(text).toMatch(/\+\d+ more line\(s\) not shown/);
	});

	it("shows a small batch in full with no overflow note", () => {
		const batch = emptyBatch();
		pushEvent(batch, "a");
		pushEvent(batch, "b");
		expect(formatMonitorBatch("m3", "log", batch)).toBe("Monitor m3 (log) emitted 2 event(s):\na\nb");
	});
});
