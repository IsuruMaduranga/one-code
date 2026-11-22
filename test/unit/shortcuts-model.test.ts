import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHelpKey, commandRows, guideUrl, type HelpData, helpListRows, helpPanelLines, helpText, initialHelpState } from "../../extensions/lib/ui/shortcuts-help.ts";
import { shortcutColumns, shortcutLines, type ShortcutSources } from "../../extensions/lib/ui/shortcuts-model.ts";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";

/** pi's default keys, as its keyText names them. */
const PI_KEYS: Record<string, string> = {
	"app.interrupt": "escape",
	"app.thinking.cycle": "shift+tab",
	"app.tools.expand": "ctrl+o",
	"app.thinking.toggle": "ctrl+t",
	"tui.editor.undo": "ctrl+-",
	"app.suspend": "ctrl+z",
	"app.clipboard.pasteImage": "ctrl+v",
	"app.model.select": "ctrl+l",
	"app.editor.external": "ctrl+g",
};

const sources = (keys: Record<string, string> = PI_KEYS, extra: Partial<ShortcutSources> = {}): ShortcutSources => ({
	keyText: (binding) => keys[binding] ?? "",
	modeCycleKey: "ctrl+q",
	taskToggleKey: "ctrl+\\",
	editorKeys: { stash: "ctrl+s", historySearch: "ctrl+r", clearInput: true },
	...extra,
});

const rows = (columns: ReturnType<typeof shortcutColumns>) => columns.map((column) => column.map((row) => `${row.key} ${row.text}`));

describe("shortcutColumns", () => {
	it("lists One Code's keys in Claude Code's three columns", () => {
		expect(rows(shortcutColumns(sources()))).toEqual([
			["! for shell mode", "/ for commands", "@ for file paths", "/btw for side question"],
			[
				"esc esc to clear input",
				"shift+tab to change effort",
				"ctrl+q to cycle modes",
				"ctrl+o to expand output",
				"ctrl+t to show thinking",
				"ctrl+\\ to toggle tasks",
				"\\ then enter for newline",
				"↓ to manage agents",
			],
			[
				"ctrl+- to undo",
				"ctrl+z to suspend",
				"ctrl+v to paste images",
				"ctrl+l to switch model",
				"ctrl+s to stash prompt",
				"ctrl+r to search history",
				"ctrl+g to edit in $EDITOR",
				"ctrl+x ctrl+s to send now",
				"ctrl+x ctrl+k to stop agents",
				"/hotkeys for all keys",
			],
		]);
	});

	it("reads each pi key from the user's bindings", () => {
		const columns = shortcutColumns(sources({ ...PI_KEYS, "app.interrupt": "ctrl+[", "app.model.select": "alt+p" }));
		expect(rows(columns)[1]?.[0]).toBe("ctrl+[ ctrl+[ to clear input");
		expect(rows(columns)[2]).toContain("alt+p to switch model");
	});

	it("drops the row of an unbound key, an absent command and a missing editor key", () => {
		const { "app.suspend": _suspend, ...unbound } = PI_KEYS;
		const columns = rows(shortcutColumns(sources(unbound, { hasCommand: (name) => name !== "btw" && name !== "hotkeys", editorKeys: {} })));
		const all = columns.flat();
		expect(all.some((row) => row.includes("suspend"))).toBe(false);
		expect(all.some((row) => row.startsWith("/btw"))).toBe(false);
		expect(all.some((row) => row.startsWith("/hotkeys"))).toBe(false);
		expect(all.some((row) => row.includes("stash") || row.includes("search history") || row.includes("clear input"))).toBe(false);
	});

	it("names every pi key with its default when pi's keyText is unavailable", () => {
		const all = rows(shortcutColumns({ modeCycleKey: "alt+m", taskToggleKey: "alt+t", editorKeys: { clearInput: true } })).flat();
		expect(all).toContain("esc esc to clear input");
		expect(all).toContain("ctrl+g to edit in $EDITOR");
		expect(all).toContain("alt+m to cycle modes");
	});
});

describe("shortcutLines", () => {
	const columns = shortcutColumns(sources());

	it("uses Claude Code's column starts (2, 26, 61) when the three columns fit", () => {
		const lines = shortcutLines(columns, 140);
		expect(lines[0]).toBe(`  ${"! for shell mode".padEnd(24)}${"esc esc to clear input".padEnd(35)}ctrl+- to undo`);
		expect(lines).toHaveLength(10);
		expect(lines[9]).toBe(`${" ".repeat(61)}/hotkeys for all keys`);
	});

	it("falls back to two columns, then one, and never passes the width", () => {
		for (const width of [70, 40, 20]) {
			const lines = shortcutLines(columns, width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(shortcutLines(columns, 70)).toHaveLength(11);
		expect(shortcutLines(columns, 40)).toHaveLength(22);
		expect(shortcutLines(columns, 20).some((line) => line.endsWith("…"))).toBe(true);
	});
});

describe("the /help panel", () => {
	const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => `[${text}]` };
	const data: HelpData = {
		intro: "One Code, the Claude Code experience, on any model.",
		shortcuts: shortcutColumns(sources()),
		commands: Array.from({ length: 30 }, (_, i) => ({ name: `cmd${String(i).padStart(2, "0")}`, description: `Command ${i}` })),
		custom: [],
		moreHelp: "https://example.test/docs",
	};

	it("draws Claude Code's tab row and General tab", () => {
		const lines = helpPanelLines(initialHelpState(), data, 140, 30, plain);
		expect(lines[1]).toBe("  Help [ General ]  Commands   Custom commands ");
		expect(lines).toContain("  Shortcuts");
		expect(lines).toContain("  For more help: https://example.test/docs");
		expect(lines.at(-1)).toBe("  ←/→ to switch · Esc to close");
	});

	it("leaves out the guide line for a brand that names no guide folder (the fixture product's)", () => {
		const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "profile", "brand.json"), "utf8")) as { homepage: string; guideDir?: string };
		expect(guideUrl(fixture)).toBeUndefined();
		expect(guideUrl({ homepage: "https://github.com/o/r", guideDir: "docs/guide" })).toBe("https://github.com/o/r/tree/master/docs/guide");
		const { moreHelp: _omit, ...noGuide } = data;
		const lines = helpPanelLines(initialHelpState(), noGuide, 140, 30, plain);
		expect(lines.some((line) => line.includes("For more help"))).toBe(false);
		expect(lines.at(-1)).toBe("  ←/→ to switch · Esc to close");
		expect(helpText(noGuide)).not.toContain("For more help");
	});

	it("fits the General tab to a short panel and scrolls it, the hint always shown", () => {
		const state = initialHelpState();
		const first = helpPanelLines(state, data, 40, 20, plain);
		expect(first).toHaveLength(20);
		expect(first.at(-1)).toContain("Esc to close");
		expect(first.join("\n")).toContain("↑/↓ to scroll");
		// Down reaches the last row, the guide line; it stops there.
		for (let i = 0; i < 40; i++) applyHelpKey(state, "down", data, 0, { width: 40, height: 20 });
		const last = helpPanelLines(state, data, 40, 20, plain);
		expect(last).toHaveLength(20);
		expect(last.some((line) => line.includes("For more help"))).toBe(true);
		expect(last.at(-1)).toContain("Esc to close");
		applyHelpKey(state, "up", data, 0, { width: 40, height: 20 });
		expect(helpPanelLines(state, data, 40, 20, plain)).not.toEqual(last);
		// A panel tall enough shows everything with the plain hint and ignores ↑/↓.
		const tall = initialHelpState();
		applyHelpKey(tall, "down", data, 0, { width: 140, height: 30 });
		expect(tall.scroll).toBe(0);
		expect(helpPanelLines(tall, data, 140, 30, plain).at(-1)).toBe("  ←/→ to switch · Esc to close");
	});

	it("switches tabs with ←/→, wrapping, and closes on Esc", () => {
		const state = initialHelpState();
		expect(applyHelpKey(state, "left", data, 10)).toBeUndefined();
		expect(state.tab).toBe(2);
		applyHelpKey(state, "right", data, 10);
		expect(state.tab).toBe(0);
		expect(applyHelpKey(state, "escape", data, 10)).toBe("close");
		// A key the hint does not name does nothing.
		applyHelpKey(state, "tab", data, 10);
		expect(state.tab).toBe(0);
	});

	it("scrolls the command list within its rows and marks what is hidden", () => {
		const state = { tab: 1, scroll: 0 };
		const height = 14;
		const listRows = helpListRows(height, 100, 1);
		let lines = helpPanelLines(state, data, 100, height, plain);
		expect(lines).toHaveLength(height);
		expect(lines).toContain(`  ↓ ${30 - listRows + 1} more`);
		for (let i = 0; i < 50; i++) applyHelpKey(state, "down", data, listRows);
		expect(state.scroll).toBe(30 - listRows);
		lines = helpPanelLines(state, data, 100, height, plain);
		expect(lines).toContain(`  ${"/cmd29".padEnd(12)}Command 29`);
		expect(lines.some((line) => line.startsWith("  ↑ "))).toBe(true);
		expect(lines.at(-1)).toBe("  ←/→ to switch · ↑/↓ to scroll · Esc to close");
	});

	it("says how to add a custom command when there is none", () => {
		const lines = helpPanelLines({ tab: 2, scroll: 0 }, data, 100, 20, plain);
		expect(lines.some((line) => line.includes(".claude/commands/"))).toBe(true);
		expect(lines.at(-1)).toBe("  ←/→ to switch · Esc to close");
	});

	it("cuts command descriptions with an ellipsis in terminal columns", () => {
		const [row] = commandRows([{ name: "doctor", description: "x".repeat(200) }], 60);
		expect(visibleWidth(row ?? "")).toBe(60);
		expect(row?.endsWith("…")).toBe(true);
	});

	it("prints the same content as text where no panel can open", () => {
		const text = helpText({ ...data, commands: data.commands.slice(0, 2), custom: [{ name: "mine", description: "My command" }] });
		expect(text).toContain("Shortcuts:");
		expect(text).toContain("esc esc to clear input");
		expect(text).toContain("  /cmd00 - Command 0");
		expect(text).toContain("Custom commands:\n  /mine - My command");
		expect(text.endsWith("For more help: https://example.test/docs")).toBe(true);
	});
});
