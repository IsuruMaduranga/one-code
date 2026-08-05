import { describe, expect, it } from "vitest";
import {
	acceptedEffortArgs,
	choiceForState,
	decodeKey,
	EFFORT_CHOICES,
	isEffortChoice,
	moveIndex,
	parseEffortArg,
	renderEffortSlider,
	THINKING_LEVELS,
	thinkingLevelFor,
	ULTRACODE,
	ULTRACODE_LEVEL,
} from "../../extensions/effort/slider.ts";

// Identity paint keeps layout assertions free of colour codes.
const plain = (_color: string, text: string) => text;
const render = (index: number, width = 120) => renderEffortSlider({ index, width }, plain);

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
		expect([...EFFORT_CHOICES]).toEqual([...THINKING_LEVELS, ULTRACODE]);
		for (const level of THINKING_LEVELS) expect(isEffortChoice(level)).toBe(true);
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
	const n = EFFORT_CHOICES.length;

	it("clamps at both ends instead of wrapping", () => {
		expect(moveIndex(0, "left", n)).toBe(0);
		expect(moveIndex(n - 1, "right", n)).toBe(n - 1);
		expect(moveIndex(2, "right", n)).toBe(3);
		expect(moveIndex(2, "left", n)).toBe(1);
	});

	it("jumps to either end", () => {
		expect(moveIndex(3, "first", n)).toBe(0);
		expect(moveIndex(3, "last", n)).toBe(n - 1);
	});

	it("leaves the index alone for confirm/cancel", () => {
		expect(moveIndex(3, "confirm", n)).toBe(3);
		expect(moveIndex(3, "cancel", n)).toBe(3);
	});
});

describe("renderEffortSlider", () => {
	it("shows the title, both ends, every stop, and the key hints", () => {
		const out = render(2).join("\n");
		expect(out).toContain("Effort");
		expect(out).toContain("Faster");
		expect(out).toContain("Smarter");
		for (const choice of EFFORT_CHOICES) expect(out).toContain(choice);
		expect(out).toContain("←/→ adjust");
		expect(out).toContain("Enter confirm");
		expect(out).toContain("Esc cancel");
		// Says which key does the same job, so the two dials don't look unrelated.
		expect(out).toContain("shift+tab");
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
		const lines = renderEffortSlider({ index: EFFORT_CHOICES.length - 1, width: 140 }, (c, t) => `<${c}>${t}</${c}>`);
		expect(lines.join("\n")).toContain("<accent>ultracode</accent>");
	});
});
