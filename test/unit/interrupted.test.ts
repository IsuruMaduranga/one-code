import { describe, expect, it } from "vitest";
import { RunOutcomeLatch, runOutcome, wasInterrupted } from "../../extensions/lib/interrupt.ts";
import { INTERRUPTED_TEXT } from "../../extensions/interrupted/line.ts";

describe("INTERRUPTED_TEXT", () => {
	it("mirrors Claude Code's InterruptedByUser wording, rebranded", () => {
		expect(INTERRUPTED_TEXT).toBe("Interrupted · What should One Code do instead?");
	});
});

describe("wasInterrupted", () => {
	it("is true when the last assistant message was aborted", () => {
		expect(wasInterrupted([{ role: "assistant", stopReason: "aborted" }])).toBe(true);
	});

	it("is false when the last assistant message ran to completion", () => {
		expect(wasInterrupted([{ role: "assistant", stopReason: "stop" }])).toBe(false);
		expect(wasInterrupted([{ role: "assistant", stopReason: "toolUse" }])).toBe(false);
	});

	it("is false for a provider error, which is a failure and not an interruption", () => {
		expect(wasInterrupted([{ role: "assistant", stopReason: "error" }])).toBe(false);
	});

	// The message walk itself is covered once, under runOutcome, which this delegates to.
	it("is safe with no assistant message and on undefined", () => {
		expect(wasInterrupted([{ role: "user" }])).toBe(false);
		expect(wasInterrupted(undefined)).toBe(false);
	});
});

describe("runOutcome", () => {
	it("separates a provider error from an abort and a clean finish", () => {
		expect(runOutcome([{ role: "assistant", stopReason: "error" }])).toBe("error");
		expect(runOutcome([{ role: "assistant", stopReason: "aborted" }])).toBe("aborted");
		expect(runOutcome([{ role: "assistant", stopReason: "stop" }])).toBe("ok");
	});

	it("reads the LAST assistant message, so a recovered retry reads as ok", () => {
		expect(
			runOutcome([
				{ role: "assistant", stopReason: "error" },
				{ role: "assistant", stopReason: "stop" },
			]),
		).toBe("ok");
	});

	it("ignores trailing tool results and earlier assistant messages", () => {
		expect(
			runOutcome([
				{ role: "assistant", stopReason: "toolUse" },
				{ role: "toolResult" },
				{ role: "assistant", stopReason: "aborted" },
				{ role: "toolResult" },
			]),
		).toBe("aborted");
	});

	it("treats an empty run as ok", () => {
		expect(runOutcome([])).toBe("ok");
	});

	it("treats a run with no assistant message as ok, and is safe on undefined", () => {
		expect(runOutcome([{ role: "user" }])).toBe("ok");
		expect(runOutcome(undefined)).toBe("ok");
	});

	// Measured over RPC (STEERING-REVIEW-2026-09-05 L1): an abort landing between
	// a stored tool result and the next provider call is labelled "error" by pi.
	// The run's signal is aborted, and that is what says it was the user's abort.
	it("reads an error stop on an aborted run as aborted", () => {
		expect(runOutcome([{ role: "assistant", stopReason: "error" }], true)).toBe("aborted");
		expect(wasInterrupted([{ role: "assistant", stopReason: "error" }], true)).toBe(true);
		const latch = new RunOutcomeLatch();
		latch.record([{ role: "assistant", stopReason: "error" }], true);
		expect(latch.take()).toBe("aborted");
	});

	it("leaves a provider error on a live run, and a completed run whose signal aborted late, alone", () => {
		expect(runOutcome([{ role: "assistant", stopReason: "error" }], false)).toBe("error");
		expect(runOutcome([{ role: "assistant", stopReason: "error" }])).toBe("error");
		// The signal only reclassifies an error stop: a turn that finished before
		// the abort landed was not interrupted.
		expect(runOutcome([{ role: "assistant", stopReason: "stop" }], true)).toBe("ok");
		expect(runOutcome([{ role: "assistant", stopReason: "toolUse" }], true)).toBe("ok");
	});
});

describe("RunOutcomeLatch", () => {
	it("carries the last run's outcome to whoever takes it", () => {
		const latch = new RunOutcomeLatch();
		latch.record([{ role: "assistant", stopReason: "error" }]);
		expect(latch.take()).toBe("error");
	});

	it("keeps only the latest run, so a recovered retry settles as ok", () => {
		const latch = new RunOutcomeLatch();
		latch.record([{ role: "assistant", stopReason: "error" }]);
		latch.record([{ role: "assistant", stopReason: "stop" }]);
		expect(latch.take()).toBe("ok");
	});

	it("clears on take, so one turn's failure never leaks into the next", () => {
		const latch = new RunOutcomeLatch();
		latch.record([{ role: "assistant", stopReason: "aborted" }]);
		expect(latch.take()).toBe("aborted");
		expect(latch.take()).toBeUndefined();
	});

	// Distinct from "ok": a caller gating on === "ok" must hold off on a turn where
	// no run ended at all, rather than read a default as success.
	it("reads undefined before any run has ended", () => {
		expect(new RunOutcomeLatch().take()).toBeUndefined();
	});
});
