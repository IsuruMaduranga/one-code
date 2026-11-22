import { describe, expect, it } from "vitest";
import { DOUBLE_ESC_MS, EscapeClear, type EscapeContext, fitBorderTitle, HistorySearch, PromptHistory, PromptStash } from "../../extensions/lib/ui/editor-conveniences.ts";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";

const free: EscapeContext = { hasText: true, idle: true, menuOpen: false, viewOpen: false, bashMode: false, bashRunning: false };

describe("EscapeClear", () => {
	it("clears on a second Esc inside the window", () => {
		const esc = new EscapeClear();
		expect(esc.press(1000, free)).toBe("arm");
		expect(esc.armed(1000 + DOUBLE_ESC_MS - 1)).toBe(true);
		expect(esc.press(1000 + DOUBLE_ESC_MS - 1, free)).toBe("clear");
		// After a clear the next Esc starts over.
		expect(esc.press(1000 + DOUBLE_ESC_MS, free)).toBe("arm");
	});

	it("arms again when the second Esc comes too late", () => {
		const esc = new EscapeClear();
		esc.press(0, free);
		expect(esc.armed(DOUBLE_ESC_MS)).toBe(false);
		expect(esc.press(DOUBLE_ESC_MS, free)).toBe("arm");
	});

	it("starts over after any other key", () => {
		const esc = new EscapeClear();
		esc.press(0, free);
		esc.other();
		expect(esc.press(10, free)).toBe("arm");
	});

	it.each([
		["an empty or blank input", { hasText: false }],
		["a running turn (Esc interrupts it)", { idle: false }],
		["an open menu (Esc closes it)", { menuOpen: true }],
		["an open agent view (Esc leaves it)", { viewOpen: true }],
		["a shell command (pi clears it on one Esc)", { bashMode: true }],
	])("leaves Esc alone on %s", (_name, change) => {
		const esc = new EscapeClear();
		expect(esc.press(0, { ...free, ...change })).toBe("pass");
		expect(esc.press(1, { ...free, ...change })).toBe("pass");
		// A pass also drops an earlier arm.
		esc.press(2, free);
		esc.press(3, { ...free, ...change });
		expect(esc.press(4, free)).toBe("arm");
	});
});

describe("PromptStash", () => {
	it("stashes a non-empty input and brings it back on an empty one", () => {
		const stash = new PromptStash();
		expect(stash.toggle("half a thought")).toBe("");
		expect(stash.stashed).toBe(true);
		expect(stash.toggle("")).toBe("half a thought");
		expect(stash.stashed).toBe(false);
		expect(stash.toggle("")).toBeUndefined();
	});

	it("keeps one slot: a second stash replaces the first", () => {
		const stash = new PromptStash();
		stash.toggle("first");
		stash.toggle("second");
		expect(stash.toggle("")).toBe("second");
	});

	it("comes back after a submit once the editor is empty, and waits otherwise", () => {
		const stash = new PromptStash();
		stash.toggle("later");
		expect(stash.afterSubmit("pi put this back")).toBeUndefined();
		expect(stash.stashed).toBe(true);
		expect(stash.afterSubmit("")).toBe("later");
		expect(stash.afterSubmit("")).toBeUndefined();
	});
});

describe("history search", () => {
	const history = new PromptHistory();
	for (const prompt of ["fix the parser", "  ", "run the tests", "run the tests", "fix the lexer", "deploy"]) history.add(prompt);

	it("keeps pi-tui's history rules: trimmed, no blanks, no consecutive duplicates, newest first", () => {
		expect(history.entries).toEqual(["deploy", "fix the lexer", "run the tests", "fix the parser"]);
		const capped = new PromptHistory();
		for (let i = 0; i < 105; i++) capped.add(`p${i}`);
		expect(capped.entries).toHaveLength(100);
		expect(capped.entries[0]).toBe("p104");
	});

	it("narrows to the newest match and steps to older ones", () => {
		const search = new HistorySearch();
		search.start("draft");
		expect(search.setQuery("fix", history.entries)).toBe("fix the lexer");
		expect(search.prompt()).toBe("search prompts: fix");
		expect(search.older(history.entries)).toBe("fix the parser");
		// No older match: it stays on the last one.
		expect(search.older(history.entries)).toBe("fix the parser");
	});

	it("says when nothing matches and keeps the last match", () => {
		const search = new HistorySearch();
		search.start("draft");
		search.setQuery("run", history.entries);
		expect(search.setQuery("runz", history.entries)).toBe("run the tests");
		expect(search.prompt()).toBe("no matching prompt: runz");
		expect(search.setQuery("", history.entries)).toBe("draft");
	});

	it("cancels back to the draft, and accepting ends the search", () => {
		const search = new HistorySearch();
		search.start("my draft");
		search.setQuery("deploy", history.entries);
		expect(search.cancel()).toBe("my draft");
		expect(search.active).toBe(false);
		search.start("");
		search.accept();
		expect(search.active).toBe(false);
	});
});

describe("fitBorderTitle", () => {
	const border = (width: number) => `\x1b[38;5;8m${"─".repeat(width)}\x1b[39m`;

	it("fits the title into a plain border, Claude Code's `──── Title ─`", () => {
		expect(fitBorderTitle(border(80), "Auto-mode handoff feature")).toBe("Auto-mode handoff feature");
	});

	it("cuts a long title with an ellipsis, keeping the badge helper's left margin", () => {
		const width = 40;
		const title = fitBorderTitle(border(width), "A much longer session title than the border can hold");
		expect(title.endsWith("…")).toBe(true);
		// applyBorderBadge draws only when its tail (title, two spaces, the glyph) leaves four columns.
		expect(visibleWidth(title) + 2 + 1 + 4).toBeLessThanOrEqual(width);
	});

	it("stays clear of the working status and of a reserved badge", () => {
		const top = `── ✽ Metamorphosing… (2s · ↓ 26 tokens) ${"─".repeat(30)}`;
		const title = fitBorderTitle(top, "Session title that is long");
		// The run of 30 border glyphs: the closing one, two spaces, four of gap.
		expect(visibleWidth(title)).toBe(30 - 1 - 2 - 4);
		expect(fitBorderTitle(top, "Session title", 20)).toBe("");
	});

	it("shows nothing without a name, or when only a stub would fit", () => {
		expect(fitBorderTitle(border(80), undefined)).toBe("");
		expect(fitBorderTitle(border(80), "   ")).toBe("");
		expect(fitBorderTitle(border(10), "A title")).toBe("");
	});

	it("measures wide glyphs in columns", () => {
		const title = fitBorderTitle(border(20), "設定を開いて選び直す");
		expect(visibleWidth(title)).toBeLessThanOrEqual(20 - 7);
	});
});
