import { describe, expect, it } from "vitest";
import { wasInterrupted } from "../../extensions/lib/interrupt.ts";
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

	it("keys off the LAST assistant message, ignoring earlier ones and trailing tool results", () => {
		expect(
			wasInterrupted([
				{ role: "assistant", stopReason: "toolUse" },
				{ role: "toolResult" },
				{ role: "assistant", stopReason: "aborted" },
				{ role: "toolResult" },
			]),
		).toBe(true);
	});

	it("is false with no assistant message, and safe on undefined", () => {
		expect(wasInterrupted([{ role: "user" }])).toBe(false);
		expect(wasInterrupted([])).toBe(false);
		expect(wasInterrupted(undefined)).toBe(false);
	});
});
