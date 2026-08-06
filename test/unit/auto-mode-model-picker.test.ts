import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistClassifierModel } from "../../extensions/auto-mode/config.ts";
import {
	decodePickerKey,
	filterEntries,
	matchRank,
	renderModelPicker,
	windowStart,
} from "../../extensions/auto-mode/model-picker.ts";

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
			{ entries, index: 1, query: "", total: entries.length, current: "anthropic/claude-sonnet-5" },
			plain,
		).join("\n");
		expect(lines).toContain("❯ anthropic/claude-sonnet-5");
		expect(lines).toContain("✓ current");
		expect(lines).toContain("$0.25/M in");
	});

	it("warns the picker sends prompts to whichever provider is chosen", () => {
		const lines = renderModelPicker({ entries, index: 0, query: "", total: entries.length }, plain).join("\n");
		expect(lines).toContain("reads your prompts");
	});

	it("says so when nothing matches", () => {
		const lines = renderModelPicker({ entries: [], index: 0, query: "zzz", total: 4 }, plain).join("\n");
		expect(lines).toContain("no available model matches");
	});

	it("reports how many of the catalog match a filter", () => {
		const lines = renderModelPicker(
			{ entries: entries.slice(0, 1), index: 0, query: "haiku", total: entries.length },
			plain,
		).join("\n");
		expect(lines).toContain("1 of 4 models match");
	});
});

describe("persistClassifierModel", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cc-picker-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const settingsPath = () => join(home, ".claude", "settings.json");
	const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf-8"));

	it("creates the settings file when there is none", () => {
		rmSync(join(home, ".claude"), { recursive: true, force: true });
		persistClassifierModel("openai/gpt-5-mini", home);
		expect(readSettings()).toEqual({ autoMode: { classifierModel: "openai/gpt-5-mini" } });
	});

	it("preserves unrelated keys, including other autoMode fields", () => {
		writeFileSync(
			settingsPath(),
			JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] }, autoMode: { classifyAllShell: true } }),
		);
		persistClassifierModel("anthropic/claude-haiku-4-5", home);
		expect(readSettings()).toEqual({
			permissions: { allow: ["Bash(npm test:*)"] },
			autoMode: { classifyAllShell: true, classifierModel: "anthropic/claude-haiku-4-5" },
		});
	});

	it("removes the setting on clear, dropping an emptied autoMode block", () => {
		writeFileSync(settingsPath(), JSON.stringify({ autoMode: { classifierModel: "openai/gpt-5-mini" } }));
		persistClassifierModel(undefined, home);
		expect(readSettings()).toEqual({});
	});

	it("refuses to clobber a malformed settings file", () => {
		// A lenient read merely skips rules; a lenient write would replace the
		// user's whole settings file with only ours.
		writeFileSync(settingsPath(), "{not json");
		expect(() => persistClassifierModel("openai/gpt-5-mini", home)).toThrow();
		expect(readFileSync(settingsPath(), "utf-8")).toBe("{not json");
	});
});
