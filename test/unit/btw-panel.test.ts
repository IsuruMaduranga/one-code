import { describe, expect, it } from "vitest";
import { applyBtwKey, BTW_HINT, decodeBtwKey, initialBtwState, renderBtwPanel } from "../../extensions/btw/panel.ts";
import { visibleWidth } from "../../extensions/lib/tui-render.ts";

describe("decodeBtwKey", () => {
	it("maps arrows, paging, home/end, copy and close", () => {
		expect(decodeBtwKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeBtwKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeBtwKey("\x1b[5~")).toEqual({ kind: "pageUp" });
		expect(decodeBtwKey("\x1b[6~")).toEqual({ kind: "pageDown" });
		expect(decodeBtwKey("\x1b[H")).toEqual({ kind: "top" });
		expect(decodeBtwKey("\x1b[F")).toEqual({ kind: "bottom" });
		expect(decodeBtwKey("c")).toEqual({ kind: "copy" });
		expect(decodeBtwKey("\x1b")).toEqual({ kind: "close" });
		expect(decodeBtwKey("q")).toEqual({ kind: "close" });
		expect(decodeBtwKey("z")).toBeUndefined();
	});
});

describe("applyBtwKey", () => {
	it("scrolls within [0, maxOffset] and clears the copied flag on any key", () => {
		const state = initialBtwState();
		state.maxOffset = 5;
		state.viewport = 4;
		state.copied = true;

		expect(applyBtwKey(state, { kind: "down" })).toBeUndefined();
		expect(state.offset).toBe(1);
		expect(state.copied).toBe(false);

		applyBtwKey(state, { kind: "up" });
		applyBtwKey(state, { kind: "up" });
		expect(state.offset).toBe(0); // clamped at top

		applyBtwKey(state, { kind: "bottom" });
		expect(state.offset).toBe(5);
		applyBtwKey(state, { kind: "down" });
		expect(state.offset).toBe(5); // clamped at bottom

		applyBtwKey(state, { kind: "top" });
		expect(state.offset).toBe(0);
	});

	it("pages by viewport minus one line of overlap", () => {
		const state = initialBtwState();
		state.maxOffset = 20;
		state.viewport = 10;
		applyBtwKey(state, { kind: "pageDown" });
		expect(state.offset).toBe(9);
		applyBtwKey(state, { kind: "pageUp" });
		expect(state.offset).toBe(0);
	});

	it("returns copy and close effects without moving", () => {
		const state = initialBtwState();
		expect(applyBtwKey(state, { kind: "copy" })).toEqual({ kind: "copy" });
		expect(applyBtwKey(state, { kind: "close" })).toEqual({ kind: "close" });
	});
});

describe("renderBtwPanel", () => {
	const plain = (lines: string[]) => lines.join("\n");

	it("shows the question, the answer and the key hint", () => {
		const state = initialBtwState();
		const lines = renderBtwPanel({ state, question: "why?", body: { kind: "answer", text: "because." }, width: 40, height: 12 });
		const text = plain(lines);
		expect(text).toContain("Side question");
		expect(text).toContain("why?");
		expect(text).toContain("because.");
		expect(text).toContain(BTW_HINT);
	});

	it("shows a loading line before the answer arrives", () => {
		const state = initialBtwState();
		const lines = renderBtwPanel({ state, question: "q", body: { kind: "loading" }, width: 40, height: 12 });
		expect(plain(lines)).toContain("Thinking…");
	});

	it("shows the error message on failure", () => {
		const state = initialBtwState();
		const lines = renderBtwPanel({ state, question: "q", body: { kind: "error", message: "no api key" }, width: 40, height: 12 });
		expect(plain(lines)).toContain("Side question failed: no api key");
	});

	it("shows a placeholder for an empty answer", () => {
		const state = initialBtwState();
		const lines = renderBtwPanel({ state, question: "q", body: { kind: "answer", text: "" }, width: 40, height: 12 });
		expect(plain(lines)).toContain("(no answer)");
	});

	it("clamps offset and reports a scroll window for a long answer", () => {
		const state = initialBtwState();
		state.offset = 999;
		const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const lines = renderBtwPanel({ state, question: "q", body: { kind: "answer", text }, width: 70, height: 12 });
		expect(state.maxOffset).toBeGreaterThan(0);
		expect(state.offset).toBe(state.maxOffset); // clamped down from 999
		expect(plain(lines)).toContain(`of ${50}`);
	});

	it("confirms a copy in the footer", () => {
		const state = initialBtwState();
		state.copied = true;
		const lines = renderBtwPanel({ state, question: "q", body: { kind: "answer", text: "a" }, width: 40, height: 12 });
		expect(plain(lines)).toContain("Copied to clipboard");
	});

	it("bounds the header on a long question so total lines stay within height", () => {
		const state = initialBtwState();
		const question = "why is this happening ".repeat(60); // wraps to many lines
		const height = 12;
		const lines = renderBtwPanel({ state, question, body: { kind: "answer", text: "short" }, width: 40, height });
		expect(lines.length).toBeLessThanOrEqual(height);
		// The body still gets at least one row.
		expect(plain(lines)).toContain("short");
		// The truncated question is marked with an ellipsis.
		expect(plain(lines)).toContain("…");
	});

	it("never emits a line wider than the width", () => {
		const state = initialBtwState();
		const text = "a very long unbroken line ".repeat(20);
		const width = 30;
		const lines = renderBtwPanel({ state, question: "an equally long question ".repeat(10), body: { kind: "answer", text }, width, height: 14 });
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
