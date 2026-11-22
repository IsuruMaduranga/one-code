/**
 * The slash-command menu's rows, shaped like Claude Code's (pure, no pi
 * imports). pi's menu lists its own built-ins first, then every other command
 * in load order, tags each command that did not ship with pi with its source
 * ("[t]", "[u]", "[u:npm:…]": pi's interactive-mode.js
 * `prefixAutocompleteDescription`), and cuts a long description with no
 * ellipsis. Claude Code lists `/name` rows alphabetically with no tags and
 * ends a cut description with "…" (the ui-parity evidence, cc-02-slash.txt).
 *
 * `arrangeSlashItems` runs in the branding extension's autocomplete wrapper
 * (branding owns the editor); `fitSlashDescriptions` and `slashMenuRows` run in
 * the prompt editor, which knows the width and the terminal's height. `/help`
 * lays out its command rows with the same name column and order.
 */

import { visibleWidth } from "./text-width.ts";
import { cutPlainText } from "./tui-render.ts";

/** One autocomplete row, pi-tui's `AutocompleteItem` shape. */
export interface MenuItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * pi built-ins the menu leaves out, by whether their replacement runs. Typing
 * one still runs it: pi matches its built-ins by the submitted text, never
 * through the menu.
 * - `thinking`: One Code's `/effort` sets the same level (and more), under
 *   Claude Code's name; two rows for one dial read as two features. Without
 *   the effort feature, `/thinking` is the only way to the dial, so it stays.
 */
export function hiddenMenuCommands(effortEnabled: boolean): ReadonlySet<string> {
	return new Set(effortEnabled ? ["thinking"] : []);
}

/** The menu's order: by name, ignoring case. */
export function compareCommandNames(a: string, b: string): number {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x < y ? -1 : x > y ? 1 : 0;
}

/** pi's source tag: `[t]`, `[u]`, `[p]`, or one of those with `:npm:…` / `:git:…`. */
const SOURCE_TAG = /^\[[tup](?::[^\]\s]*)?\](?= |$)/;

/**
 * The description without pi's source tag. pi puts the tag first, and a
 * prompt template's argument hint goes before that: `<hint> — [u] text`.
 */
export function stripSourceTag(description: string): string {
	const hinted = description.indexOf(" — [");
	for (const start of hinted >= 0 ? [0, hinted + 3] : [0]) {
		const tag = SOURCE_TAG.exec(description.slice(start));
		if (!tag) continue;
		const rest = description.slice(start + tag[0].length).trimStart();
		const head = description.slice(0, start);
		return rest ? head + rest : head.replace(/ — $/, "");
	}
	return description;
}

/** True for the menu of command names (`/`, `/co`), not a command's argument completions. */
export function isCommandMenu(prefix: string): boolean {
	return prefix.startsWith("/") && !prefix.includes(" ");
}

/**
 * The command menu as Claude Code draws it: `/name` labels, no source tags,
 * the hidden built-ins dropped, and alphabetical while nothing is typed after
 * the slash. A typed filter keeps pi's fuzzy ranking (no Claude Code screen
 * shows a filtered menu). Other menus pass through unchanged.
 */
export function arrangeSlashItems<T extends MenuItem>(items: T[], prefix: string, hidden: ReadonlySet<string>): T[] {
	if (!isCommandMenu(prefix)) return items;
	const rows = items
		.filter((item) => !hidden.has(item.value))
		.map((item) => {
			const label = item.label.startsWith("/") ? item.label : `/${item.label}`;
			const description = item.description === undefined ? undefined : stripSourceTag(item.description) || undefined;
			return { ...item, label, description };
		});
	if (prefix !== "/") return rows;
	return rows.sort((a, b) => compareCommandNames(a.value, b.value));
}

// pi-tui's SelectList with the editor's slash-menu layout (select-list.js,
// editor.js SLASH_COMMAND_SELECT_LIST_LAYOUT).
const PREFIX_WIDTH = 2;
const COLUMN_GAP = 2;
const MIN_COLUMN = 12;
const MAX_COLUMN = 32;
/** The fewest columns a description is shown in. */
export const MIN_DESCRIPTION = 10;

/** The name column for these names: the widest plus a gap, between 12 and 32 columns. */
export function slashNameColumn(names: readonly string[]): number {
	const widest = names.reduce((max, name) => Math.max(max, visibleWidth(name) + COLUMN_GAP), 0);
	return Math.min(Math.max(widest, MIN_COLUMN), MAX_COLUMN);
}

/**
 * Cut each description to the columns pi-tui's list gives it at
 * `contentWidth`, ending with "…", so pi's own cut (which has no ellipsis)
 * never applies. The column math is SelectList's: the name column is the
 * widest name plus a gap, between 12 and 32 columns; the description gets
 * what is left after the pointer and a two-column margin, and only when the
 * list is wider than 40 columns and that leaves more than 10.
 */
export function fitSlashDescriptions<T extends MenuItem>(items: T[], contentWidth: number): T[] {
	if (contentWidth <= 40 || items.length === 0) return items;
	const column = slashNameColumn(items.map((item) => item.label || item.value));
	const effective = Math.max(1, Math.min(column, contentWidth - PREFIX_WIDTH - 4));
	return items.map((item) => {
		if (!item.description) return item;
		const single = item.description.replace(/[\r\n]+/g, " ").trim();
		const nameWidth = Math.min(visibleWidth(item.label || item.value), Math.max(1, effective - COLUMN_GAP));
		const spacing = Math.max(1, effective - nameWidth);
		const room = contentWidth - (PREFIX_WIDTH + nameWidth + spacing) - 2;
		if (room <= MIN_DESCRIPTION || visibleWidth(single) <= room) return item;
		return { ...item, description: cutPlainText(single, room) };
	});
}

/** pi's default for `autocompleteMaxVisible`, and its bounds. */
export const PI_MENU_ROWS = 5;
const MAX_MENU_ROWS = 20;
/** Rows kept for everything but the menu: Claude Code shows 21 of them in a 45-row terminal. */
const ROWS_KEPT = 24;

/**
 * How many rows the menu shows. A value the user set in pi's settings (any
 * value but pi's default) wins; otherwise the menu grows with the terminal,
 * Claude Code's 21 rows at 45, within pi's limit of 20, and never below pi's
 * 5, so a short terminal keeps today's menu and the editor stays on screen.
 */
export function slashMenuRows(terminalRows: number, configured: number): number {
	if (configured !== PI_MENU_ROWS) return configured;
	if (!Number.isFinite(terminalRows)) return PI_MENU_ROWS;
	return Math.min(MAX_MENU_ROWS, Math.max(PI_MENU_ROWS, Math.floor(terminalRows) - ROWS_KEPT));
}
