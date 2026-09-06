import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	alignRight,
	cutPlainText,
	padPlainText,
	splitCell,
	truncateLine,
	wrapPlainText,
} from "../../extensions/lib/tui-render.ts";
import { graphemeWidth, sliceColumns, visibleWidth } from "../../extensions/lib/text-width.ts";
import { resolvePiTuiEntry } from "../../extensions/subagents/prose.ts";

// pi-tui's own column measure — the authority a rendered line is validated
// against in the live TUI (it crashes on a line wider than the terminal). Every
// helper must produce output whose pi-tui width is ≤ the requested width.
let piVisibleWidth: (s: string) => number;

beforeAll(async () => {
	const mod = (await import(pathToFileURL(resolvePiTuiEntry()).href)) as { visibleWidth?: (s: string) => number };
	if (typeof mod.visibleWidth !== "function") throw new Error("pi-tui exports no visibleWidth");
	piVisibleWidth = mod.visibleWidth;
});

const WIDE = "漢字テスト日本語"; // 8 ideographs = 16 columns
const EMOJI = "wave 👋🏽 flag 🇯🇵 family 👨‍👩‍👧‍👦";
const ANSI = "\x1b[31m赤い文字\x1b[0m";
const MIXED = `ascii ${WIDE} ${EMOJI} más café`;

describe("visibleWidth matches pi-tui", () => {
	it("agrees with pi-tui across CJK, emoji, marks and ANSI", () => {
		for (const s of ["", "hi", WIDE, EMOJI, ANSI, MIXED, "café", "ｆｕｌｌ", "\t tab", "→←↑↓"]) {
			expect(visibleWidth(s)).toBe(piVisibleWidth(s));
		}
	});
	it("counts a CJK ideograph as two columns", () => {
		expect(visibleWidth("漢")).toBe(2);
		expect(graphemeWidth("漢")).toBe(2);
		expect(graphemeWidth("a")).toBe(1);
		expect(graphemeWidth("👋🏽")).toBe(2);
	});
});

describe("width helpers never exceed the requested width (pi-tui measure)", () => {
	// cut/pad/alignRight/wrap take PLAIN text (painting happens after); only
	// truncateLine is ANSI-aware, so ANSI stays out of the plain-helper cases.
	const cases = [WIDE, EMOJI, MIXED, "漢".repeat(60), "café ".repeat(20)];
	const widths = [2, 5, 10, 20, 40, 79, 80];

	it("truncateLine fits every width", () => {
		for (const line of [WIDE, EMOJI, ANSI, MIXED]) {
			for (const w of widths) {
				expect(piVisibleWidth(truncateLine(line, w))).toBeLessThanOrEqual(w);
			}
		}
	});
	it("cutPlainText fits every width", () => {
		for (const line of cases) {
			for (const w of widths) {
				expect(piVisibleWidth(cutPlainText(line, w))).toBeLessThanOrEqual(w);
			}
		}
	});
	it("padPlainText is exactly the requested width", () => {
		for (const line of cases) {
			for (const w of widths) {
				expect(piVisibleWidth(padPlainText(line, w))).toBe(w);
			}
		}
	});
	it("alignRight fits every width", () => {
		for (const line of cases) {
			for (const w of widths) {
				expect(piVisibleWidth(alignRight(line, w))).toBeLessThanOrEqual(w);
			}
		}
	});
	it("wrapPlainText never emits an overwide line", () => {
		// width ≥ 2: a single 2-column glyph cannot fit in a 1-column budget, an
		// impossibility no real terminal presents.
		for (const line of [MIXED, "漢".repeat(60), EMOJI]) {
			for (const w of [2, 5, 10, 40]) {
				for (const out of wrapPlainText(line, w)) {
					expect(piVisibleWidth(out)).toBeLessThanOrEqual(w);
				}
			}
		}
	});
	it("splitCell is exactly the requested width", () => {
		for (const w of [20, 40, 80]) {
			expect(piVisibleWidth(splitCell(WIDE, "12 tok", w))).toBe(w);
			expect(piVisibleWidth(splitCell("short", EMOJI, w))).toBe(w);
		}
	});
});

describe("H1 regression: the crashing fixture", () => {
	// A task_create call line with a 60-ideograph subject killed pi at 80 cols
	// because truncateLine returned it unchanged (raw length 65 ≤ 80, visible 125).
	it("truncates a 60-ideograph line to ≤ 80 columns", () => {
		const line = `● Create Task(${"漢".repeat(60)})`;
		const out = truncateLine(line, 80);
		expect(piVisibleWidth(out)).toBeLessThanOrEqual(80);
	});
	it("keeps pure-ASCII output byte-identical", () => {
		expect(truncateLine("plain ascii line", 80)).toBe("plain ascii line");
		expect(cutPlainText("hello world", 5)).toBe("hell…");
		expect(padPlainText("hi", 5)).toBe("hi   ");
	});
});

describe("sliceColumns keeps graphemes whole", () => {
	it("never splits a wide glyph across the boundary", () => {
		const r = sliceColumns("a漢b", 2); // 'a'(1) + '漢'(2) = 3 > 2, so only 'a'
		expect(r.text).toBe("a");
		expect(r.width).toBe(1);
	});
});
