import { describe, expect, it } from "vitest";
import { WORDMARK, WORDMARK_WIDTH, bannerLines, sectionSummary, truncateLine } from "../../extensions/branding/index.ts";
import { shouldDefaultHideThinking } from "../../extensions/branding/startup.ts";

// Identity paint keeps assertions about layout free of colour codes.
const plain = (_color: string, text: string) => text;
// The context line is the one carrying the mode; find it rather than hard-code
// its index, which now shifts with the wordmark block height.
const contextLine = (lines: string[]) => lines.find((l) => l.includes("mode ")) ?? "";

describe("bannerLines", () => {
	it("stacks the wordmark block above the tagline and version", () => {
		const lines = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		expect(lines.slice(0, WORDMARK.length)).toEqual(WORDMARK);
		const tagline = lines[WORDMARK.length];
		expect(tagline).toContain("the Claude Code experience, on any model");
		expect(tagline).toContain("v0.1.0");
	});

	it("all wordmark rows share one width, so the block is a clean rectangle", () => {
		const widths = new Set(WORDMARK.map((row) => [...row].length));
		expect(widths).toEqual(new Set([WORDMARK_WIDTH]));
	});

	it("keeps the hints to one curated line pointing at /hotkeys for the rest", () => {
		const lines = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		const hintLines = lines.filter((l) => l.includes("shift+tab"));
		expect(hintLines).toHaveLength(1);
		for (const hint of [
			"shift+tab effort",
			"ctrl+q permissions",
			"ctrl+t thinking",
			"ctrl+o expand output",
			"/ commands",
			"! bash",
			"ultracode max effort",
			"/hotkeys all keys",
		]) {
			expect(hintLines[0]).toContain(hint);
		}
	});

	it("shows the model when known and always the mode", () => {
		const lines = bannerLines({ version: "0.1.0", model: "gpt-5.5", cwd: "/p", mode: "acceptEdits" }, plain);
		const context = contextLine(lines);
		expect(context).toContain("model gpt-5.5");
		expect(context).toContain("mode acceptEdits");
	});

	it("omits the model line content when no model is resolved", () => {
		const lines = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		const context = contextLine(lines);
		expect(context).not.toContain("model");
		expect(context).toContain("default");
	});

	it("falls back to a text title below the wordmark width", () => {
		const narrow = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain, WORDMARK_WIDTH - 1);
		// No wordmark row survives; the head is the plain brand name.
		expect(narrow.some((l) => WORDMARK.includes(l))).toBe(false);
		expect(narrow[0]).toContain("One Code");
	});

	it("summarizes long sections to counts and keeps short ones by name", () => {
		const summary = sectionSummary(
			[
				{ label: "context", items: ["CLAUDE.md"] },
				{ label: "skills", items: Array.from({ length: 12 }, (_v, i) => `skill-${i}`) },
				{ label: "workflows", items: [] },
				{ label: "themes", items: ["one-code", "one-code-light"] },
			],
			plain,
		);
		expect(summary).toBe("context CLAUDE.md · skills 12 · themes one-code, one-code-light");
	});

	it("applies the paint function it is given", () => {
		const [firstRow] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, (c, t) => `<${c}>${t}</${c}>`);
		expect(firstRow).toBe(`<accent>${WORDMARK[0]}</accent>`);
	});
});

describe("truncateLine", () => {
	const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").length;

	it("leaves a line that fits alone", () => {
		expect(truncateLine("short", 80)).toBe("short");
		expect(truncateLine("\x1b[31mred\x1b[0m", 80)).toBe("\x1b[31mred\x1b[0m");
	});

	it("cuts to the visible width, not the string length", () => {
		// pi-tui crashes the whole app on an overwide line, so this is a
		// correctness bound, not cosmetics.
		const painted = `\x1b[36m${"x".repeat(200)}\x1b[0m`;
		const cut = truncateLine(painted, 50);
		expect(visible(cut)).toBeLessThanOrEqual(50);
		expect(cut.endsWith("…")).toBe(true);
	});

	it("never splits an ANSI escape and always resets before the ellipsis", () => {
		const painted = `${"a".repeat(10)}\x1b[35m${"b".repeat(10)}`;
		const cut = truncateLine(painted, 15);
		expect(cut).toContain("\x1b[35m");
		expect(cut).toContain("\x1b[0m…");
		expect(visible(cut)).toBe(15);
	});

	it("every banner line respects a narrow width", () => {
		const paint = (_c: string, t: string) => `\x1b[36m${t}\x1b[0m`;
		const lines = bannerLines(
			{
				version: "1.0.0",
				model: "claude-haiku-4-5",
				cwd: "/repo",
				mode: "auto · classifier haiku-4-5 (planned)",
				sections: [{ label: "skills", items: Array.from({ length: 30 }, (_v, i) => `skill-${i}`) }],
			},
			paint,
			80,
		);
		for (const line of lines) {
			expect(visible(line)).toBeLessThanOrEqual(80);
		}
	});
});

describe("shouldDefaultHideThinking", () => {
	it("defaults on when settings do not exist yet", () => {
		expect(shouldDefaultHideThinking(undefined)).toBe(true);
	});

	it("defaults on when the key was never set", () => {
		expect(shouldDefaultHideThinking("{}")).toBe(true);
		expect(shouldDefaultHideThinking('{"quietStartup": true}')).toBe(true);
	});

	it("never overrides a user choice, in either direction", () => {
		expect(shouldDefaultHideThinking('{"hideThinkingBlock": false}')).toBe(false);
		expect(shouldDefaultHideThinking('{"hideThinkingBlock": true}')).toBe(false);
	});

	it("does not touch a settings file it cannot parse", () => {
		expect(shouldDefaultHideThinking("{broken")).toBe(false);
	});
});
