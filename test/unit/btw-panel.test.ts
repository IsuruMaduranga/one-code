import { describe, expect, it } from "vitest";
import { applyBtwKey, type BtwPanelInput, decodeBtwKey, initialBtwState, renderBtwPanel, SHOWN_HISTORY } from "../../extensions/btw/panel.ts";
import { visibleWidth } from "../../extensions/lib/tui-render.ts";

describe("decodeBtwKey", () => {
	it("maps arrows, paging, home/end, copy, fork, clear and close", () => {
		expect(decodeBtwKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeBtwKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeBtwKey("\x1b[5~")).toEqual({ kind: "pageUp" });
		expect(decodeBtwKey("\x1b[6~")).toEqual({ kind: "pageDown" });
		expect(decodeBtwKey("\x1b[H")).toEqual({ kind: "top" });
		expect(decodeBtwKey("\x1b[F")).toEqual({ kind: "bottom" });
		expect(decodeBtwKey("c")).toEqual({ kind: "copy" });
		expect(decodeBtwKey("f")).toEqual({ kind: "fork" });
		expect(decodeBtwKey("x")).toEqual({ kind: "clear" });
		for (const key of ["\x1b", "\x03", "\x04", "\r", " ", "q"]) expect(decodeBtwKey(key)).toEqual({ kind: "close" });
		expect(decodeBtwKey("z")).toBeUndefined();
	});

	it("maps Claude Code's browse keys: shift+arrows and brackets step, Tab cycles", () => {
		expect(decodeBtwKey("\x1b[1;2D")).toEqual({ kind: "browse", direction: "older", wrap: false });
		expect(decodeBtwKey("\x1b[1;2C")).toEqual({ kind: "browse", direction: "newer", wrap: false });
		expect(decodeBtwKey("[")).toEqual({ kind: "browse", direction: "older", wrap: false });
		expect(decodeBtwKey("]")).toEqual({ kind: "browse", direction: "newer", wrap: false });
		expect(decodeBtwKey("\t")).toEqual({ kind: "browse", direction: "older", wrap: true });
		expect(decodeBtwKey("\x1b[Z")).toEqual({ kind: "browse", direction: "newer", wrap: true });
	});
});

describe("applyBtwKey", () => {
	it("scrolls three lines a press within [0, maxOffset] and clears the copied flag", () => {
		const state = initialBtwState();
		state.maxOffset = 5;
		state.viewport = 4;
		state.copied = true;

		expect(applyBtwKey(state, { kind: "down" }, 0)).toBeUndefined();
		expect(state.offset).toBe(3);
		expect(state.copied).toBe(false);
		applyBtwKey(state, { kind: "down" }, 0);
		expect(state.offset).toBe(5); // clamped at bottom
		applyBtwKey(state, { kind: "up" }, 0);
		applyBtwKey(state, { kind: "up" }, 0);
		expect(state.offset).toBe(0); // clamped at top

		applyBtwKey(state, { kind: "bottom" }, 0);
		expect(state.offset).toBe(5);
		applyBtwKey(state, { kind: "top" }, 0);
		expect(state.offset).toBe(0);
	});

	it("pages by viewport minus one line of overlap", () => {
		const state = initialBtwState();
		state.maxOffset = 20;
		state.viewport = 10;
		applyBtwKey(state, { kind: "pageDown" }, 0);
		expect(state.offset).toBe(9);
		applyBtwKey(state, { kind: "pageUp" }, 0);
		expect(state.offset).toBe(0);
	});

	it("returns copy, fork, clear and close effects without moving", () => {
		const state = initialBtwState();
		for (const kind of ["copy", "fork", "clear", "close"] as const) expect(applyBtwKey(state, { kind }, 2)).toEqual({ kind });
		expect(state.offset).toBe(0);
	});

	it("browses older then newer, stopping at both ends, and resets the scroll", () => {
		const state = initialBtwState();
		state.offset = 4;
		const older = { kind: "browse", direction: "older", wrap: false } as const;
		const newer = { kind: "browse", direction: "newer", wrap: false } as const;
		applyBtwKey(state, older, 2);
		expect(state.selected).toBe(1); // the newest earlier exchange
		expect(state.offset).toBe(0);
		applyBtwKey(state, older, 2);
		expect(state.selected).toBe(0);
		applyBtwKey(state, older, 2);
		expect(state.selected).toBe(0); // stops at the oldest
		applyBtwKey(state, newer, 2);
		applyBtwKey(state, newer, 2);
		expect(state.selected).toBeNull(); // back to the current question
		applyBtwKey(state, newer, 2);
		expect(state.selected).toBeNull();
	});

	it("cycles with Tab, and reaches only the listed earlier questions", () => {
		const state = initialBtwState();
		const tab = { kind: "browse", direction: "older", wrap: true } as const;
		const historyLength = SHOWN_HISTORY + 3;
		const seen: (number | null)[] = [];
		for (let i = 0; i < SHOWN_HISTORY + 1; i++) {
			applyBtwKey(state, tab, historyLength);
			seen.push(state.selected);
		}
		expect(seen).toEqual([7, 6, 5, 4, 3, null]);
	});

	it("does nothing when there is no history to browse", () => {
		const state = initialBtwState();
		applyBtwKey(state, { kind: "browse", direction: "older", wrap: true }, 0);
		expect(state.selected).toBeNull();
	});
});

describe("renderBtwPanel", () => {
	const plain = (lines: string[]) => lines.join("\n");
	const render = (input: Partial<BtwPanelInput>) =>
		renderBtwPanel({ state: initialBtwState(), history: [], question: "q", body: { kind: "answer", text: "a" }, width: 60, height: 20, ...input });

	it("marks the current question with /btw and indents the answer under it", () => {
		const lines = render({ question: "why?", body: { kind: "answer", text: "because." } });
		expect(lines).toContain("  /btw why?");
		expect(lines).toContain("    because.");
	});

	it("names only the keys that apply", () => {
		expect(render({ body: { kind: "loading" } }).at(-1)).toBe("  Esc to close");
		expect(render({}).at(-1)).toBe("  ↑/↓ to scroll · c to copy · Esc to close");
		expect(render({ canFork: true }).at(-1)).toBe("  ↑/↓ to scroll · c to copy · f to fork · Esc to close");
		const withHistory = render({ canFork: true, width: 100, history: [{ question: "earlier", answer: "then" }] });
		expect(withHistory.at(-1)).toBe("  ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close");
	});

	it("lists earlier questions above the current one, with a count past five", () => {
		const history = Array.from({ length: SHOWN_HISTORY + 2 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
		const lines = render({ history, question: "now" });
		expect(lines).toContain("  (+2 earlier /btw)");
		expect(lines).not.toContain("  /btw q1");
		const listed = lines.filter((line) => line.startsWith("  /btw "));
		expect(listed).toEqual(["  /btw q2", "  /btw q3", "  /btw q4", "  /btw q5", "  /btw q6", "  /btw now"]);
	});

	it("shows a browsed answer, and offers no fork for it", () => {
		const state = initialBtwState();
		state.selected = 0;
		const lines = render({ state, canFork: true, history: [{ question: "earlier", answer: "then" }], body: { kind: "answer", text: "now" } });
		expect(lines).toContain("    then");
		expect(lines).not.toContain("    now");
		expect(plain(lines)).not.toContain("f to fork");
	});

	it("shows a loading line, the error, and a placeholder for an empty answer", () => {
		expect(plain(render({ body: { kind: "loading" } }))).toContain("Answering…");
		expect(plain(render({ body: { kind: "error", message: "no api key" } }))).toContain("no api key");
		expect(plain(render({ body: { kind: "answer", text: "" } }))).toContain("(no answer)");
	});

	it("says Forking… while a fork starts, and confirms a copy", () => {
		expect(render({ forking: true }).at(-1)).toBe("  Forking…");
		const state = initialBtwState();
		state.copied = true;
		expect(plain(render({ state }))).toContain("Copied to clipboard");
	});

	it("renders the answer through the given renderer, at the indented width", () => {
		const widths: number[] = [];
		const lines = render({ width: 50, renderAnswer: (text, width) => (widths.push(width), [`<${text}>`]) });
		expect(widths).toEqual([46]);
		expect(lines).toContain("    <a>");
	});

	it("clamps the offset for a long answer and keeps within height", () => {
		const state = initialBtwState();
		state.offset = 999;
		const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const lines = render({ state, body: { kind: "answer", text }, height: 12 });
		expect(state.maxOffset).toBeGreaterThan(0);
		expect(state.offset).toBe(state.maxOffset);
		expect(lines.length).toBeLessThanOrEqual(12);
	});

	it("puts a long question on one line with an ellipsis", () => {
		const lines = render({ question: "why is this happening ".repeat(60), width: 40 });
		const row = lines.find((line) => line.startsWith("  /btw "));
		expect(row).toContain("…");
		expect(lines.filter((line) => line.includes("why is this")).length).toBe(1);
	});

	it("never emits a line wider than the width", () => {
		const width = 30;
		const lines = render({
			question: "an equally long question ".repeat(10),
			history: [{ question: "earlier and long ".repeat(10), answer: "x" }],
			body: { kind: "answer", text: "a very long unbroken line ".repeat(20) },
			width,
			height: 14,
		});
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
