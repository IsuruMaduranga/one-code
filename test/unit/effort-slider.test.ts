import { describe, expect, it } from "vitest";
import {
	effortNoteText,
	acceptedEffortArgs,
	choiceForState,
	decodeKey,
	EFFORT_CHOICES,
	enabledStops,
	isEffortChoice,
	levelRank,
	moveIndex,
	nearestEnabled,
	parseEffortArg,
	renderEffortSlider,
	sliderNoteReader,
	thinkingLevelFor,
	ULTRACODE,
	ULTRACODE_LEVEL,
} from "../../extensions/lib/ui/effort-slider.ts";
import { THINKING_LEVEL_NAMES } from "../../extensions/lib/profile/thinking-defaults.ts";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";

// Identity paint keeps layout assertions free of colour codes.
const plain = (_color: string, text: string) => text;
// Most layout assertions don't care about model support, so default to all-on.
const ALL_ON = EFFORT_CHOICES.map(() => true);
const render = (index: number, width = 120, enabled: boolean[] = ALL_ON) =>
	renderEffortSlider({ index, enabled, width }, plain);

describe("choices", () => {
	it("runs Faster→Smarter and ends at ultracode", () => {
		expect([...EFFORT_CHOICES]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"]);
		expect(EFFORT_CHOICES[EFFORT_CHOICES.length - 1]).toBe(ULTRACODE);
	});

	/**
	 * The whole point of the alignment: shift+tab is pi's and cycles the full
	 * thinking ladder, so the slider must offer exactly those stops plus
	 * ultracode — otherwise the two dials disagree about the same number.
	 */
	it("covers every level shift+tab can reach, plus ultracode", () => {
		expect([...EFFORT_CHOICES]).toEqual([...THINKING_LEVEL_NAMES, ULTRACODE]);
		for (const level of THINKING_LEVEL_NAMES) expect(isEffortChoice(level)).toBe(true);
	});

	it("maps ultracode to the top level, everything else to itself", () => {
		expect(thinkingLevelFor(ULTRACODE)).toBe(ULTRACODE_LEVEL);
		expect(thinkingLevelFor("high")).toBe("high");
		expect(thinkingLevelFor("max")).toBe("max");
		expect(thinkingLevelFor("off")).toBe("off");
	});

	it("accepts every stop as a typed arg", () => {
		for (const choice of EFFORT_CHOICES) expect(parseEffortArg(choice)).toBe(choice);
		expect(acceptedEffortArgs()).toEqual([...EFFORT_CHOICES]);
	});

	it("parses case-insensitively and rejects junk", () => {
		expect(parseEffortArg("  ULTRACODE ")).toBe("ultracode");
		expect(parseEffortArg("XHigh")).toBe("xhigh");
		expect(parseEffortArg("turbo")).toBeUndefined();
		expect(parseEffortArg("")).toBeUndefined();
	});
});

describe("choiceForState", () => {
	it("preselects ultracode when the mode is on, whatever the level", () => {
		expect(choiceForState("xhigh", true)).toBe(ULTRACODE);
		expect(choiceForState("low", true)).toBe(ULTRACODE);
	});

	it("preselects the matching stop otherwise", () => {
		expect(choiceForState("medium", false)).toBe("medium");
		expect(choiceForState("max", false)).toBe("max");
		expect(choiceForState("off", false)).toBe("off");
		expect(choiceForState("minimal", false)).toBe("minimal");
	});

	it("falls back to a mid stop when the level is unknown", () => {
		expect(choiceForState(undefined, false)).toBe("medium");
	});
});

describe("decodeKey", () => {
	it("decodes both arrow encodings terminals send", () => {
		expect(decodeKey("\x1b[C")).toBe("right");
		expect(decodeKey("\x1bOC")).toBe("right");
		expect(decodeKey("\x1b[D")).toBe("left");
		expect(decodeKey("\x1bOD")).toBe("left");
	});

	it("decodes confirm and cancel", () => {
		expect(decodeKey("\r")).toBe("confirm");
		expect(decodeKey("\n")).toBe("confirm");
		expect(decodeKey("\x1b")).toBe("cancel");
		expect(decodeKey("\x03")).toBe("cancel");
	});

	it("ignores anything else", () => {
		expect(decodeKey("x")).toBeUndefined();
		expect(decodeKey("\x1b[A")).toBeUndefined();
	});
});

describe("moveIndex", () => {
	const all = EFFORT_CHOICES.map(() => true);
	const n = all.length;

	it("clamps at both ends instead of wrapping", () => {
		expect(moveIndex(0, "left", all)).toBe(0);
		expect(moveIndex(n - 1, "right", all)).toBe(n - 1);
		expect(moveIndex(2, "right", all)).toBe(3);
		expect(moveIndex(2, "left", all)).toBe(1);
	});

	it("jumps to either end", () => {
		expect(moveIndex(3, "first", all)).toBe(0);
		expect(moveIndex(3, "last", all)).toBe(n - 1);
	});

	it("leaves the index alone for confirm/cancel", () => {
		expect(moveIndex(3, "confirm", all)).toBe(3);
		expect(moveIndex(3, "cancel", all)).toBe(3);
	});

	it("skips disabled stops so the marker only lands on selectable levels", () => {
		// deepseek-v4-flash: only high + max (+ ultracode) are reachable.
		const enabled = enabledStops(["high", "max"]);
		const high = EFFORT_CHOICES.indexOf("high");
		const max = EFFORT_CHOICES.indexOf("max");
		const ultra = EFFORT_CHOICES.indexOf(ULTRACODE);
		// From high, left has nothing enabled below it — stays put; right jumps to max.
		expect(moveIndex(high, "left", enabled)).toBe(high);
		expect(moveIndex(high, "right", enabled)).toBe(max);
		expect(moveIndex(max, "right", enabled)).toBe(ultra);
		// first/last snap to the first/last enabled stop, not index 0 / the array end.
		expect(moveIndex(ultra, "first", enabled)).toBe(high);
		expect(moveIndex(high, "last", enabled)).toBe(ultra);
	});
});

describe("enabledStops", () => {
	it("enables only the model's supported plain levels, aligned to the choices", () => {
		const enabled = enabledStops(["high", "max"]);
		for (const [i, choice] of EFFORT_CHOICES.entries()) {
			const expected = choice === "high" || choice === "max" || choice === ULTRACODE;
			expect(enabled[i], choice).toBe(expected);
		}
	});

	it("enables ultracode whenever the model can reason at all", () => {
		const ultra = EFFORT_CHOICES.indexOf(ULTRACODE);
		expect(enabledStops(["off", "low"])[ultra]).toBe(true);
		// A model with no reasoning level (off only) can't reach ultracode.
		expect(enabledStops(["off"])[ultra]).toBe(false);
	});

	it("enables every plain stop for a full-ladder model", () => {
		const enabled = enabledStops([...THINKING_LEVEL_NAMES]);
		expect(enabled.every(Boolean)).toBe(true);
	});
});

describe("nearestEnabled", () => {
	const enabled = enabledStops(["high", "max"]);
	const high = EFFORT_CHOICES.indexOf("high");

	it("keeps an already-enabled index", () => {
		expect(nearestEnabled(high, enabled)).toBe(high);
	});

	it("snaps a disabled index onto the nearest enabled stop", () => {
		// medium (disabled) sits just below high (enabled).
		expect(nearestEnabled(EFFORT_CHOICES.indexOf("medium"), enabled)).toBe(high);
		// off (disabled, far left) still resolves to the first enabled stop.
		expect(nearestEnabled(EFFORT_CHOICES.indexOf("off"), enabled)).toBe(high);
	});
});

describe("levelRank", () => {
	it("orders the ladder so a downward clamp is detectable", () => {
		expect(levelRank("low")).toBeLessThan(levelRank("high"));
		expect(levelRank("high")).toBeLessThan(levelRank("max"));
		expect(levelRank("off")).toBe(0);
	});
});

describe("renderEffortSlider", () => {
	it("shows the title, both ends, every stop, and the key hints", () => {
		const out = render(2).join("\n");
		expect(out).toContain("Effort");
		expect(out).toContain("Faster");
		expect(out).toContain("Smarter");
		for (const choice of EFFORT_CHOICES) expect(out).toContain(choice);
		expect(out).toContain("←/→ or h/l adjust");
		expect(out).toContain("Enter confirm");
		expect(out).toContain("Esc cancel");
		// Says which key does the same job, so the two dials don't look unrelated.
		expect(out).toContain("shift+tab");
		// The cost the user is about to pay is on screen, not something to learn later.
		expect(out).toContain("re-caches the conversation");
	});

	it("puts the marker under the selected label", () => {
		const lines = render(EFFORT_CHOICES.indexOf("high"));
		const markerRow = lines.find((l) => l.includes("▲"));
		const labelRow = lines.find((l) => l.includes("medium") && l.includes("high"));
		expect(markerRow).toBeDefined();
		expect(labelRow).toBeDefined();
		const markerColumn = [...(markerRow as string)].indexOf("▲");
		const labelStart = (labelRow as string).indexOf("high");
		// Marker sits within the selected label's own columns.
		expect(markerColumn).toBeGreaterThanOrEqual(labelStart);
		expect(markerColumn).toBeLessThan(labelStart + "high".length);
	});

	it("separates ultracode from the plain levels with a divider", () => {
		const out = render(0).join("\n");
		expect(out).toContain("│");
	});

	it("explains ultracode only while ultracode is selected", () => {
		const subtitle = `${ULTRACODE_LEVEL} + workflows`;
		expect(render(EFFORT_CHOICES.indexOf(ULTRACODE)).join("\n")).toContain(subtitle);
		expect(render(EFFORT_CHOICES.indexOf("high")).join("\n")).not.toContain(subtitle);
	});

	it("degrades to a single line rather than wrapping in a narrow pane", () => {
		const lines = render(2, 20);
		expect(lines.length).toBeLessThan(6);
		expect(lines.join("\n")).toContain("Effort");
	});

	it("keeps every line within the width it is given, at any width", () => {
		for (const width of [200, 120, 100, 80, 60, 40, 20, 10]) {
			for (const index of [0, 3, EFFORT_CHOICES.length - 1]) {
				for (const line of render(index, width)) {
					expect([...line].length, `index ${index} at width ${width}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("applies the paint function it is given", () => {
		const lines = renderEffortSlider(
			{ index: EFFORT_CHOICES.length - 1, enabled: ALL_ON, width: 140 },
			(c, t) => `<${c}>${t}</${c}>`,
		);
		expect(lines.join("\n")).toContain("<accent>ultracode</accent>");
	});

	it("dims unsupported stops and explains them, naming the model", () => {
		const enabled = enabledStops(["high", "max"]);
		const tag = (c: string, t: string) => `<${c}>${t}</${c}>`;
		const high = EFFORT_CHOICES.indexOf("high");
		const out = renderEffortSlider({ index: high, enabled, width: 140, modelLabel: "DeepSeek V4 Flash" }, tag).join("\n");
		// An unsupported level is painted dim; a supported, unselected one is muted.
		expect(out).toContain("<dim>low</dim>");
		expect(out).toContain("<muted>max</muted>");
		expect(out).toContain("dimmed = unsupported by DeepSeek V4 Flash");
	});

	it("omits the unsupported note when the model reaches every stop", () => {
		expect(render(2).join("\n")).not.toContain("unsupported");
	});
});

describe("effortNoteText", () => {
	it("maps levels onto Claude Code's effort symbols", () => {
		expect(effortNoteText("low", false)).toBe("○ low · /effort");
		expect(effortNoteText("medium", false)).toBe("◐ medium · /effort");
		expect(effortNoteText("high", false)).toBe("● high · /effort");
		expect(effortNoteText("xhigh", false)).toBe("◉ xhigh · /effort");
		expect(effortNoteText("max", false)).toBe("◉ max · /effort");
		expect(effortNoteText("off", false)).toBe("○ off · /effort");
	});

	it("keeps ultracode's own badge", () => {
		expect(effortNoteText("xhigh", true)).toBe("✦ ultracode · /effort");
	});
});

describe("the profile's slider note", () => {
	const HIGH = EFFORT_CHOICES.indexOf("high");
	const withNote = (index: number, note: string | undefined, width = 120, enabled: boolean[] = ALL_ON) =>
		renderEffortSlider({ index, enabled, width, note }, plain);
	const markerColumn = (lines: string[]) => [...lines.find((l) => l.includes("▲"))!].indexOf("▲");

	it("draws no row, and the same bytes as before, when the profile has no note", () => {
		const unsupported = enabledStops(["high", "max"]);
		expect(renderEffortSlider({ index: HIGH, enabled: unsupported, width: 120, modelLabel: "Test Model" }, plain)).toEqual([
			"Effort",
			"",
			"Faster                                          Smarter",
			"────────────────────────────────────────────│──────────",
			"                             ▲",
			"off  minimal  low  medium  high  xhigh  max │ ultracode",
			"dimmed = unsupported by Test Model",
			"changing effort re-caches the conversation (one uncached request)",
			"",
			"←/→ or h/l adjust · Enter confirm · s for this session only · Esc cancel · shift+tab cycles the plain levels",
		]);
		const paint = (c: string, t: string) => `<${c}>${t}</${c}>`;
		const without = renderEffortSlider({ index: HIGH, enabled: ALL_ON, width: 120 }, paint);
		for (const note of [undefined, "", "  \t ", "\n second line only"]) {
			expect(renderEffortSlider({ index: HIGH, enabled: ALL_ON, width: 120, note }, paint)).toEqual(without);
		}
	});

	it("puts the note right under the track rows, dim, before the unsupported and cache notes", () => {
		const paint = (c: string, t: string) => `<${c}>${t}</${c}>`;
		const lines = renderEffortSlider({ index: HIGH, enabled: enabledStops(["high", "max"]), width: 120, modelLabel: "M", note: "Pricier, slower" }, paint);
		const at = lines.indexOf("<dim>Pricier, slower</dim>");
		expect(at).toBeGreaterThan(0);
		expect(lines[at - 1]).toContain("<accent>high</accent>");
		expect(lines[at + 1]).toBe("<dim>dimmed = unsupported by M</dim>");
	});

	it("sits under the ultracode subtitle on the last stop", () => {
		const lines = withNote(EFFORT_CHOICES.indexOf(ULTRACODE), "All in");
		const subtitle = lines.findIndex((l) => l.includes(`${ULTRACODE_LEVEL} + workflows`));
		expect(subtitle).toBeGreaterThan(0);
		expect(lines[subtitle + 1]).toBe("All in");
	});

	it("follows the highlighted stop: each index shows its own text", () => {
		const noteFor = (index: number) => `note for ${EFFORT_CHOICES[index]}`;
		for (let index = 0; index < EFFORT_CHOICES.length; index++) {
			const out = withNote(index, noteFor(index));
			expect(out).toContain(noteFor(index));
			expect(out.filter((l) => l.startsWith("note for "))).toHaveLength(1);
		}
	});

	it("draws no row for an empty or whitespace note", () => {
		for (const note of [undefined, "", "   ", "\n", " \r\n  "]) expect(withNote(HIGH, note)).toEqual(render(HIGH));
	});

	it("shows only the first line, trimmed", () => {
		const out = withNote(HIGH, "  first line  \nsecond line\r\nthird");
		expect(out).toContain("first line");
		expect(out.join("\n")).not.toContain("second");
		expect(out.join("\n")).not.toContain("third");
		expect(withNote(HIGH, "only\u2028rest").join("\n")).not.toContain("rest");
	});

	it("keeps the marker under its label with or without a note", () => {
		for (let index = 0; index < EFFORT_CHOICES.length; index++) {
			expect(markerColumn(withNote(index, "a note"))).toBe(markerColumn(render(index)));
		}
	});

	it("never decides the layout: a very long note leaves the track as it was and is clipped", () => {
		const long = "x".repeat(130);
		for (const index of [0, HIGH, EFFORT_CHOICES.length - 1]) {
			const without = render(index);
			const out = withNote(index, long);
			expect(out.some((l) => l.includes("▲"))).toBe(true);
			expect(out.filter((l) => !l.startsWith("x"))).toEqual(without);
			expect(out).toContain("x".repeat(120));
		}
	});

	it("keeps the compact layout when the view is too narrow, with the note clipped", () => {
		const narrow = withNote(HIGH, "x".repeat(70), 40);
		expect(narrow).toContain("x".repeat(40));
		expect(narrow.some((l) => l.includes("▲"))).toBe(false);
	});

	it("draws no escape sequence or control character, whatever the note carries", () => {
		const hostile = [
			"hi\x1b[2A\x1b]52;c;ZXZpbA==\x07there",
			"a\x1b]0;retitled\x1b\\b",
			"bell\x07 and \x08backspace\x7f del \x9b31m c1",
			"tab\there\tnow",
			"nel\u0085hidden",
			"vt\vhidden",
			"ff\fhidden",
			"cr\roverwritten",
			"\x1b[8mconcealed",
		];
		const control = /[\u0000-\u001f\u007f-\u009f]/;
		for (const note of hostile) {
			for (const width of [120, 30]) {
				for (const line of withNote(HIGH, note, width)) expect(line, JSON.stringify(note)).not.toMatch(control);
			}
		}
		const shown = withNote(HIGH, hostile[0]).join("\n");
		expect(shown).toContain("hi");
		expect(withNote(HIGH, hostile[3])).toContain("tab here now");
		for (const hidden of [hostile[4], hostile[5], hostile[6]]) expect(withNote(HIGH, hidden).join("\n")).not.toContain("hidden");
	});

	it("never lets any row exceed the width, at any width, wide characters included", () => {
		for (const note of ["a long note ".repeat(20), "注意：これは長い説明です。".repeat(8), "emoji 🎯🎯🎯🎯🎯 ".repeat(6)]) {
			for (const width of [200, 120, 100, 80, 60, 40, 20, 10, 3]) {
				for (const index of [0, HIGH, EFFORT_CHOICES.length - 1]) {
					for (const line of withNote(index, note, width)) {
						expect(visibleWidth(line), `width ${width}, index ${index}`).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});

	it("clips by terminal columns, not code points", () => {
		// 60 ideographs are 60 code points but 120 columns.
		const clipped = withNote(HIGH, "字".repeat(80), 120);
		expect(clipped).toContain("字".repeat(60));
		expect(clipped.join("\n")).not.toContain("字".repeat(61));
		expect(clipped.some((l) => l.includes("▲"))).toBe(true);
	});
});

describe("sliderNoteReader", () => {
	it("asks the profile once per stop and keeps the answer", () => {
		const calls: string[] = [];
		const read = sliderNoteReader((choice) => (calls.push(choice), `for ${choice}`), () => {});
		expect(read("max")).toBe("for max");
		expect(read("max")).toBe("for max");
		expect(read("low")).toBe("for low");
		expect(calls).toEqual(["max", "low"]);
	});

	it("treats a missing function, a non-string and a throw as no note, and reports the first throw only", () => {
		expect(sliderNoteReader(undefined, () => {})("max")).toBeUndefined();
		expect(sliderNoteReader((() => 3) as never, () => {})("max")).toBeUndefined();
		const errors: unknown[] = [];
		let calls = 0;
		const read = sliderNoteReader(() => {
			calls++;
			throw new Error("profile bug");
		}, (error) => errors.push(error));
		expect(read("max")).toBeUndefined();
		expect(read("max")).toBeUndefined();
		expect(read("low")).toBeUndefined();
		expect(calls).toBe(2);
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("profile bug");
	});
});
