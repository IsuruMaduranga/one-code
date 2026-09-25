import { describe, expect, it } from "vitest";
import {
	announceArgumentHint,
	ARGUMENT_HINT_CHANNEL,
	applyArgumentHint,
	frontmatterCommandHint,
	hintForInput,
	PI_BUILTIN_HINTS,
} from "../../extensions/lib/argument-hints.ts";

describe("hintForInput (Claude Code's typeahead rule, findings §34)", () => {
	const hints = new Map([
		["btw", { hint: "[question]" }],
		["fix", { argNames: ["issue", "branch"] }],
		["both", { hint: "<issue> [branch]", argNames: ["issue", "branch"] }],
	]);

	it("shows the hint once exactly one space follows the command, never on the bare name", () => {
		expect(hintForInput("/btw ", hints)).toBe("[question]");
		expect(hintForInput("/btw", hints)).toBeUndefined();
	});

	it("stops once the argument is typed, and ignores unhinted or partial commands", () => {
		expect(hintForInput("/btw why", hints)).toBeUndefined();
		expect(hintForInput("/btw  ", hints)).toBeUndefined();
		expect(hintForInput("/bt ", hints)).toBeUndefined();
		expect(hintForInput("/help ", hints)).toBeUndefined();
		expect(hintForInput("btw ", hints)).toBeUndefined();
	});

	it("lists the argument names not typed yet after each space", () => {
		expect(hintForInput("/fix ", hints)).toBe("[issue] [branch]");
		expect(hintForInput("/fix 42 ", hints)).toBe("[branch]");
		expect(hintForInput('/fix "two words" ', hints)).toBe("[branch]");
		expect(hintForInput("/fix 42 main ", hints)).toBeUndefined();
		expect(hintForInput("/fix 42", hints)).toBeUndefined();
		// argument-hint wins on the first space; the names take over after.
		expect(hintForInput("/both ", hints)).toBe("<issue> [branch]");
		expect(hintForInput("/both 42 ", hints)).toBe("[branch]");
	});
});

describe("applyArgumentHint", () => {
	const cursor = "\x1b[7m \x1b[0m";
	const border = "─".repeat(20);

	it("draws the placeholder into the padding after the end cursor, keeping the width", () => {
		const lines = [border, `  /btw${cursor}${" ".repeat(13)}`, border];
		const out = applyArgumentHint(lines, " [question]");
		expect(out[1]).toBe(`  /btw${cursor} [question]${" ".repeat(2)}`);
		expect(out[0]).toBe(border);
	});

	it("leaves the lines alone without an end cursor or room for the placeholder", () => {
		const noCursor = [border, "  /btw              ", border];
		expect(applyArgumentHint(noCursor, " [question]")).toBe(noCursor);
		const tight = [border, `  /btw${cursor}  `, border];
		expect(applyArgumentHint(tight, " [question]")).toBe(tight);
	});
});

describe("announcing hints", () => {
	it("announces now and again at every session_start", () => {
		const emitted: unknown[] = [];
		const starts: (() => void)[] = [];
		const pi = { events: { emit: (channel: string, data: unknown) => emitted.push([channel, data]) }, on: (_e: "session_start", fn: () => void) => starts.push(fn) };
		announceArgumentHint(pi, "loop", "[interval] [prompt]");
		expect(emitted).toEqual([[ARGUMENT_HINT_CHANNEL, { command: "loop", hint: "[interval] [prompt]" }]]);
		for (const fn of starts) fn();
		expect(emitted).toHaveLength(2);
	});

	it("reads `argument-hint` and `arguments` frontmatter, nothing else", () => {
		expect(frontmatterCommandHint({ "argument-hint": " [pr number] " })).toEqual({ hint: "[pr number]" });
		expect(frontmatterCommandHint({ arguments: "issue branch" })).toEqual({ argNames: ["issue", "branch"] });
		expect(frontmatterCommandHint({ arguments: ["issue", "1", ""] })).toEqual({ argNames: ["issue"] });
		expect(frontmatterCommandHint({ "argument-hint": "" })).toBeUndefined();
		expect(frontmatterCommandHint({ "argument-hint": 3 })).toBeUndefined();
		expect(frontmatterCommandHint(undefined)).toBeUndefined();
	});

	it("uses Claude Code's text for pi built-ins Claude Code also has", () => {
		expect(PI_BUILTIN_HINTS.model).toBe("[model]");
		expect(PI_BUILTIN_HINTS.compact).toBe("<optional custom summarization instructions>");
		expect(PI_BUILTIN_HINTS.export).toBe("[filename]");
	});
});
