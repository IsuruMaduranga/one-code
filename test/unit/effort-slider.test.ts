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
	thinkingLevelFor,
	ULTRACODE,
} from "../../extensions/effort/slider.ts";

// Identity paint keeps layout assertions free of colour codes.
const plain = (_color: string, text: string) => text;
const render = (index: number, width = 120) => renderEffortSlider({ index, width }, plain);

describe("choices", () => {
	it("runs Faster→Smarter and ends at ultracode", () => {
		expect([...EFFORT_CHOICES]).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
		expect(EFFORT_CHOICES[EFFORT_CHOICES.length - 1]).toBe(ULTRACODE);
	});

	it("maps ultracode to xhigh, everything else to itself", () => {
		expect(thinkingLevelFor(ULTRACODE)).toBe("xhigh");
		expect(thinkingLevelFor("high")).toBe("high");
		expect(thinkingLevelFor("max")).toBe("max");
	});

	it("accepts off/minimal as typed args though the track omits them", () => {
		expect(parseEffortArg("off")).toBe("off");
		expect(parseEffortArg("minimal")).toBe("minimal");
		expect(isEffortChoice("off")).toBe(false);
		expect(acceptedEffortArgs()).toContain("off");
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
	});

	it("lands on a real stop for levels the track omits", () => {
		expect(choiceForState("off", false)).toBe("low");
		expect(choiceForState("minimal", false)).toBe("low");
		expect(choiceForState(undefined, false)).toBe("high");
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
	it("clamps at both ends instead of wrapping", () => {
		expect(moveIndex(0, "left", 6)).toBe(0);
		expect(moveIndex(5, "right", 6)).toBe(5);
		expect(moveIndex(2, "right", 6)).toBe(3);
		expect(moveIndex(2, "left", 6)).toBe(1);
	});

	it("jumps to either end", () => {
		expect(moveIndex(3, "first", 6)).toBe(0);
		expect(moveIndex(3, "last", 6)).toBe(5);
	});

	it("leaves the index alone for confirm/cancel", () => {
		expect(moveIndex(3, "confirm", 6)).toBe(3);
		expect(moveIndex(3, "cancel", 6)).toBe(3);
	});
});

describe("renderEffortSlider", () => {
	it("shows the title, both ends, every stop, and the key hints", () => {
		const out = render(2).join("\n");
		expect(out).toContain("Effort");
		expect(out).toContain("Faster");
		expect(out).toContain("Smarter");
		for (const choice of EFFORT_CHOICES) expect(out).toContain(choice);
		expect(out).toContain("←/→ to adjust · Enter to confirm · Esc to cancel");
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
		expect(render(EFFORT_CHOICES.indexOf(ULTRACODE)).join("\n")).toContain("xhigh + workflows");
		expect(render(EFFORT_CHOICES.indexOf("high")).join("\n")).not.toContain("xhigh + workflows");
	});

	it("degrades to a single line rather than wrapping in a narrow pane", () => {
		const lines = render(2, 20);
		expect(lines.length).toBeLessThan(6);
		expect(lines.join("\n")).toContain("Effort");
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(80);
	});

	it("applies the paint function it is given", () => {
		const lines = renderEffortSlider({ index: 5, width: 120 }, (c, t) => `<${c}>${t}</${c}>`);
		expect(lines.join("\n")).toContain("<accent>ultracode</accent>");
	});
});
