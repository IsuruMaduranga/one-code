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
import { graphemeWidth, sliceColumns, tailColumns, visibleWidth } from "../../extensions/lib/text-width.ts";
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

// pi-tui is the authority: its measure decides whether a rendered line crashes
// regular mode. These sweeps make a pi bump that changes the measure fail here
// instead of in a user's session (a copied measure drifted once already).
describe("visibleWidth agrees with pi-tui for every code point", () => {
	const THAI = "ภาษาไทยสำหรับการทำงาน กำ น้ำ จำ";
	const LAO = "ນຳ ຄຳ ລາວ";
	it("measures the Thai and Lao AM vowels as pi-tui does", () => {
		expect(visibleWidth("กำ")).toBe(piVisibleWidth("กำ"));
		expect(visibleWidth("ນຳ")).toBe(piVisibleWidth("ນຳ"));
		expect(visibleWidth(THAI)).toBe(piVisibleWidth(THAI));
		expect(visibleWidth(LAO)).toBe(piVisibleWidth(LAO));
		const line = truncateLine(`  ⎿  ${"กำ".repeat(60)}`, 80);
		expect(piVisibleWidth(line)).toBeLessThanOrEqual(80);
		expect(piVisibleWidth(cutPlainText("กำ".repeat(60), 80))).toBeLessThanOrEqual(80);
	});

	it("sweeps U+0000 to U+3FFFF alone and after a base letter", () => {
		const bases = ["", "a", "ก", "ນ", "क", "漢"];
		const mismatches: string[] = [];
		for (let cp = 0; cp <= 0x3ffff; cp++) {
			if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are not text
			const ch = String.fromCodePoint(cp);
			for (const base of bases) {
				const s = base + ch;
				if (visibleWidth(s) !== piVisibleWidth(s)) mismatches.push(`${base}U+${cp.toString(16)}`);
			}
			if (mismatches.length > 20) break;
		}
		expect(mismatches).toEqual([]);
	}, 60_000);

	it("agrees on random strings of marks, scripts, emoji and escape sequences", () => {
		// Seeded LCG so a failure reproduces.
		let seed = 0x5eed;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) >>> 0;
			return seed % n;
		};
		const pool = [
			"a", " ", "\t", "é", "́", "ः", "क", "ि", "्", "ก", "ำ", "้", "ນ", "ຳ", "漢", "ｱ", "ｆ",
			"👋", "🏽", "‍", "️", "🇯", "🇵", "​", "­", "\x07", "\x1b", "\r", "\x7f", "\u0085",
			"\x1b[31m", "\x1b[0m", "\x1b[2K", "\x1b[1A", "\x1b[?25l", "\x1b]8;;https://x\x07", "\x1b]8;;\x1b\\",
			"\x1b]0;title\x07", "\x1b_pi:c\x07", "\x1bP1$r\x1b\\", "\x1bc", "\x1b[", "\x1b]52;c;aGk=",
		];
		for (let n = 0; n < 20_000; n++) {
			let s = "";
			const len = 1 + rand(12);
			for (let k = 0; k < len; k++) s += pool[rand(pool.length)];
			expect(visibleWidth(s), JSON.stringify(s)).toBe(piVisibleWidth(s));
		}
	});
});

describe("tailColumns keeps the end of the text by columns", () => {
	it("fits the tail on a grapheme boundary", () => {
		for (const text of [WIDE, EMOJI, MIXED, "~/プロジェクト/ウェブ", "plain/ascii/path"]) {
			for (const w of [0, 1, 3, 7, 20]) {
				const r = tailColumns(text, w);
				expect(text.endsWith(r.text)).toBe(true);
				expect(piVisibleWidth(r.text)).toBe(r.width);
				expect(r.width).toBeLessThanOrEqual(w);
			}
		}
		expect(tailColumns("a漢b", 2)).toEqual({ text: "b", width: 1 });
		expect(tailColumns("a漢b", 3)).toEqual({ text: "漢b", width: 3 });
	});
});
