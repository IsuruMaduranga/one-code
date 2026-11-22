/**
 * The `/help` panel (pure, no pi imports), in the shape of Claude Code's: a
 * tab row (`Help  General   Commands   Custom commands`), the General tab with
 * a one-line introduction, the same shortcuts as the `?` panel under a bold
 * "Shortcuts" heading and a "For more help:" link, and the hint
 * `←/→ to switch · Esc to close` (the ui-parity evidence, cc-05-help.txt).
 * No capture shows the Commands and Custom commands tabs: they list
 * `/name  description` rows the way the slash menu does, scrolled with ↑/↓.
 */

import { type Shortcut, shortcutLines } from "./shortcuts-model.ts";
import { MIN_DESCRIPTION, slashNameColumn } from "./slash-menu-model.ts";
import { sanitizeTitle } from "./terminal-text.ts";
import { cutPlainText, hintLines, padPlainText } from "./tui-render.ts";

const HELP_TABS = ["General", "Commands", "Custom commands"] as const;

/** One command row. */
export interface HelpCommand {
	/** The name without its slash. */
	name: string;
	description?: string;
}

/**
 * The user guide's address for "For more help:", built the way the base's
 * other guide links are (the homepage as a GitHub repository): only for a
 * brand that names its guide folder (`guideDir`). Without one the brand gives
 * no address, so the line is left out.
 */
export function guideUrl(brand: { homepage: string; guideDir?: string }): string | undefined {
	return brand.guideDir === undefined ? undefined : `${brand.homepage}/tree/master/${brand.guideDir}`;
}

/** What the panel shows. */
export interface HelpData {
	/** The General tab's introduction. */
	intro: string;
	shortcuts: Shortcut[][];
	/** Built-in and extension commands, skills included. */
	commands: HelpCommand[];
	/** The user's command files (Claude Code's custom commands). */
	custom: HelpCommand[];
	/** The address after "For more help:"; the line is left out without one. */
	moreHelp?: string;
}

export interface HelpState {
	tab: number;
	/** First list row shown on a command tab. */
	scroll: number;
}

export function initialHelpState(): HelpState {
	return { tab: 0, scroll: 0 };
}

export interface HelpPaint {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
}

const INDENT = "  ";
/** The top rule, the tab row, the blank under it, and the blank above the hint. */
const LIST_CHROME = 4;

function listOf(data: HelpData, tab: number): HelpCommand[] | undefined {
	return tab === 1 ? data.commands : tab === 2 ? data.custom : undefined;
}

/** The keys a tab answers, as its hint line says them; the General tab scrolls only when it overflows. */
function hints(tab: number, scrolls = tab !== 0): string {
	return scrolls ? "←/→ to switch · ↑/↓ to scroll · Esc to close" : "←/→ to switch · Esc to close";
}

/** The General tab's rows between the tab row and the hint: the introduction, the shortcuts and the guide line. */
function generalBody(data: HelpData, width: number, bold: (text: string) => string = (text) => text): string[] {
	const intro = `${INDENT}${cutPlainText(data.intro, Math.max(1, width - INDENT.length))}`;
	// Plain here, dim under the prompt: Claude Code's General tab passes no dimColor.
	const shortcuts = shortcutLines(data.shortcuts, width);
	const more = data.moreHelp === undefined ? [] : ["", cutPlainText(`${INDENT}For more help: ${data.moreHelp}`, width)];
	return [intro, "", `${INDENT}${bold("Shortcuts")}`, ...shortcuts, ...more];
}

/** The General tab's window at `width` x `height`: its rows, and how many show when they overflow (undefined when all fit). */
function generalWindow(data: HelpData, width: number, height: number): { body: string[]; rows?: number } {
	const body = generalBody(data, width);
	if (LIST_CHROME + body.length + hintLines(hints(0, false), width, INDENT).length <= height) return { body };
	return { body, rows: helpListRows(height, width, 0, true) };
}

/**
 * Apply a key (pi-tui key ids: `left`, `right`, `up`, `down`, `escape`).
 * Returns `close` for Esc; every other key the panel does not show is ignored.
 */
export function applyHelpKey(state: HelpState, key: string | undefined, data: HelpData, listRows: number, general?: { width: number; height: number }): "close" | undefined {
	if (key === "escape") return "close";
	if (key === "left" || key === "right") {
		const step = key === "left" ? -1 : 1;
		state.tab = (state.tab + step + HELP_TABS.length) % HELP_TABS.length;
		state.scroll = 0;
		return undefined;
	}
	if (key !== "up" && key !== "down") return undefined;
	const list = listOf(data, state.tab);
	// The General tab scrolls by its own window, which only the panel's size gives.
	const window = !list && general ? generalWindow(data, general.width, general.height) : undefined;
	const length = list ? list.length : window?.rows !== undefined ? window.body.length : 0;
	const rows = list ? listRows : (window?.rows ?? 0);
	if (length === 0) return undefined;
	const max = Math.max(0, length - Math.max(1, rows));
	state.scroll = Math.min(max, Math.max(0, state.scroll + (key === "up" ? -1 : 1)));
	return undefined;
}

/** How many list rows a command tab has at `height` (after its chrome and its wrapped hint). */
export function helpListRows(height: number, width: number, tab: number, scrolls = tab !== 0): number {
	return Math.max(1, height - LIST_CHROME - hintLines(hints(tab, scrolls), width, INDENT).length);
}

function tabRow(state: HelpState, paint: HelpPaint): string {
	// Claude Code: "Help", then each tab padded by a space on each side, a space apart.
	const tabs = HELP_TABS.map((label, i) => (i === state.tab ? paint.inverse(` ${label} `) : ` ${label} `)).join(" ");
	return `${INDENT}${paint.bold("Help")} ${tabs}`;
}

/** The command rows, Claude Code's slash-menu shape: `/name` in a column, then the description, cut with an ellipsis. */
export function commandRows(commands: HelpCommand[], width: number): string[] {
	const names = commands.map((command) => `/${command.name}`);
	const column = slashNameColumn(names);
	const room = width - INDENT.length;
	return commands.map((command, i) => {
		const name = names[i] ?? "";
		if (!command.description || room - column < MIN_DESCRIPTION) return `${INDENT}${cutPlainText(name, room)}`;
		return `${INDENT}${padPlainText(name, column)}${cutPlainText(sanitizeTitle(command.description), room - column)}`;
	});
}

/** The panel's lines at `width`, at most `height` of them on a command tab. */
export function helpPanelLines(state: HelpState, data: HelpData, width: number, height: number, paint: HelpPaint): string[] {
	const dim = (text: string) => paint.fg("dim", text);
	const hint = hintLines(hints(state.tab), width, INDENT).map(dim);
	const head = [paint.fg("border", "─".repeat(Math.max(0, width))), tabRow(state, paint), ""];
	const list = listOf(data, state.tab);
	if (!list) {
		const body = generalBody(data, width, paint.bold);
		const { rows } = generalWindow(data, width, height);
		if (rows === undefined) return [...head, ...body, "", ...hint];
		// Too tall for the panel: a window over the rows, scrolled with ↑/↓, the hint always shown.
		const scroll = Math.min(state.scroll, Math.max(0, body.length - rows));
		return [...head, ...body.slice(scroll, scroll + rows), "", ...hintLines(hints(0, true), width, INDENT).map(dim)];
	}
	if (list.length === 0) {
		const empty = state.tab === 2 ? "No custom commands. A Markdown file in .claude/commands/ becomes one." : "No commands.";
		// Nothing to scroll: the hint names only the keys that act.
		return [...head, `${INDENT}${cutPlainText(empty, Math.max(1, width - INDENT.length))}`, "", ...hintLines(hints(0), width, INDENT).map(dim)];
	}
	const rows = helpListRows(height, width, state.tab);
	const scroll = Math.min(state.scroll, Math.max(0, list.length - rows));
	const shown = commandRows(list, width).slice(scroll, scroll + rows);
	// An end row with rows past it turns into Claude Code's "↓ N more" (and "↑ N more" at the top).
	const above = scroll;
	const below = list.length - scroll - shown.length;
	if (below > 0 && shown.length > 1) shown[shown.length - 1] = dim(`${INDENT}↓ ${below + 1} more`);
	if (above > 0 && shown.length > 1) shown[0] = dim(`${INDENT}↑ ${above + 1} more`);
	return [...head, ...shown, "", ...hint];
}

/** The plain text `/help` prints where no panel can open (RPC, one-shot runs). */
export function helpText(data: HelpData, width = 100): string {
	const section = (title: string, commands: HelpCommand[]) =>
		commands.length === 0 ? [] : ["", `${title}:`, ...commands.map((command) => `  /${command.name}${command.description ? ` - ${sanitizeTitle(command.description)}` : ""}`)];
	return [data.intro, "", "Shortcuts:", ...shortcutLines(data.shortcuts, width), ...section("Commands", data.commands), ...section("Custom commands", data.custom), ...(data.moreHelp === undefined ? [] : ["", `For more help: ${data.moreHelp}`])].join("\n");
}
