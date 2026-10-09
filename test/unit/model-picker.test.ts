import { describe, expect, it } from "vitest";
import {
	decodePickerKey,
	filterEntries,
	matchRank,
	renderModelPicker,
	windowStart,
} from "../../extensions/lib/model-picker.ts";
import { visibleWidth } from "../../extensions/lib/text-width.ts";

const header = { title: "Select the default subagent model", subtitle: "Sets which model subagent runs use." };

const plain = (_color: string, text: string) => text;

const entries = [
	{ provider: "anthropic", id: "claude-haiku-4-5", inputPrice: 1 },
	{ provider: "anthropic", id: "claude-sonnet-5", inputPrice: 3 },
	{ provider: "openai", id: "gpt-5-mini", inputPrice: 0.25 },
	{ provider: "openrouter", id: "z-ai/glm-4.6", inputPrice: 0.5 },
];

describe("filterEntries", () => {
	it("returns everything for an empty query, in catalog order", () => {
		expect(filterEntries(entries, "")).toEqual(entries);
	});

	it("ranks prefix over substring over subsequence", () => {
		const ranked = filterEntries(entries, "openai");
		expect(ranked[0]?.id).toBe("gpt-5-mini");
	});

	it("finds a model by in-order subsequence, so users need not type separators", () => {
		expect(matchRank("anthropic/claude-haiku-4-5", "haiku45")).toBe(2);
		expect(filterEntries(entries, "haiku45").map((entry) => entry.id)).toEqual(["claude-haiku-4-5"]);
	});

	it("drops non-matches", () => {
		expect(filterEntries(entries, "grok")).toEqual([]);
		expect(matchRank("openai/gpt-5-mini", "zzz")).toBeUndefined();
	});
});

describe("decodePickerKey", () => {
	it("decodes navigation and control keys", () => {
		expect(decodePickerKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodePickerKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodePickerKey("\r")).toEqual({ kind: "confirm" });
		expect(decodePickerKey("\x1b")).toEqual({ kind: "cancel" });
		expect(decodePickerKey("\x7f")).toEqual({ kind: "backspace" });
	});

	it("treats printable characters as filter input, unlike the effort slider", () => {
		expect(decodePickerKey("h")).toEqual({ kind: "type", text: "h" });
		expect(decodePickerKey("gpt")).toEqual({ kind: "type", text: "gpt" });
	});

	it("ignores unrelated escape sequences", () => {
		expect(decodePickerKey("\x1b[C")).toBeUndefined();
		expect(decodePickerKey("\x1b[1;5A")).toBeUndefined();
	});
});

describe("windowStart", () => {
	it("shows everything when it fits", () => {
		expect(windowStart(3, 5, 10)).toBe(0);
	});

	it("keeps the cursor visible and never scrolls past the end", () => {
		expect(windowStart(0, 100, 10)).toBe(0);
		expect(windowStart(99, 100, 10)).toBe(90);
		const mid = windowStart(50, 100, 10);
		expect(mid).toBeLessThanOrEqual(50);
		expect(mid + 10).toBeGreaterThan(50);
	});
});

describe("renderModelPicker", () => {
	it("marks the cursor row and the currently configured model", () => {
		const lines = renderModelPicker(
			{ ...header, entries, index: 1, query: "", total: entries.length, current: "anthropic/claude-sonnet-5" },
			plain,
		).join("\n");
		expect(lines).toContain("❯ anthropic/claude-sonnet-5");
		expect(lines).toContain("✓ current");
		expect(lines).toContain("$0.25/M in");
	});

	it("uses the caller-provided title and subtitle", () => {
		const lines = renderModelPicker(
			{ ...header, entries, index: 0, query: "", total: entries.length, title: "Select the default subagent model", subtitle: "Sets which model subagent runs use." },
			plain,
		).join("\n");
		expect(lines).toContain("Select the default subagent model");
		expect(lines).toContain("Sets which model subagent runs use.");
		expect(lines).not.toContain("reads your prompts");
	});

	it("says so when nothing matches", () => {
		const lines = renderModelPicker({ ...header, entries: [], index: 0, query: "zzz", total: 4 }, plain).join("\n");
		expect(lines).toContain("no available model matches");
	});

	it("reports how many of the catalog match a filter", () => {
		const lines = renderModelPicker(
			{ ...header, entries: entries.slice(0, 1), index: 0, query: "haiku", total: entries.length },
			plain,
		).join("\n");
		expect(lines).toContain("1 of 4 models match");
	});

	it("cuts every line to the requested width (TUI-REVIEW H2)", () => {
		// At width 60 no row or caller-provided header may exceed 60 columns.
		const lines = renderModelPicker({ ...header, entries, index: 0, query: "", total: entries.length }, plain, 60);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("keeps the key hint on its own line", () => {
		const lines = renderModelPicker({ ...header, entries, index: 0, query: "", total: entries.length }, plain, 60);
		expect(lines.some((line) => line.includes("type to filter"))).toBe(true);
	});
});

