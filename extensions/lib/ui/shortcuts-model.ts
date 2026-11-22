/**
 * One Code's shortcuts, in the layout of Claude Code's `?` panel (pure, no pi
 * imports). Claude Code shows them under the prompt when `?` is typed into an
 * empty editor, and again on its `/help` panel's General tab: three columns,
 * input prefixes first, then keys (the ui-parity evidence, cc-03-shortcuts.txt
 * and cc-05-help.txt; column widths 24 and 35 from two columns' start at 26
 * and 61).
 *
 * Every row names a key that works in One Code, read from the live bindings:
 * a pi action's row asks pi's `keyText` for the user's key and drops out when
 * the action is unbound; One Code's own keys come from where their extensions
 * pick them (lib/ui/keys.ts) and the chords from lib/ui/ctrl-x-chord.ts.
 */

import { visibleWidth } from "./text-width.ts";
import { boundKey, cutPlainText, padPlainText } from "./tui-render.ts";

/** Where the rows read their keys. */
export interface ShortcutSources {
	/** pi's `keyText`: the user's key for a pi binding, "" when unbound. */
	keyText?: (binding: string) => string;
	/** The key that cycles permission modes (lib/ui/keys.ts modeCycleKey). */
	modeCycleKey: string;
	/** The key that shows or hides the task list (lib/ui/keys.ts taskToggleKey). */
	taskToggleKey: string;
	/** Whether a slash command exists, for rows that name one (`/btw`). */
	hasCommand?: (name: string) => boolean;
	/** The prompt editor's own keys, present only while that editor is installed (lib/ui/editor-conveniences.ts EditorKeys). */
	editorKeys?: { stash?: string; historySearch?: string; clearInput?: boolean };
}

/** pi's `keyText` (typed by pi's binding ids) over a binding named as a string, the form the rows ask in. */
export function bindingKeyText(keyText: (binding: never) => string): (binding: string) => string {
	return (binding) => keyText(binding as never);
}

/** One row: the key, then what it does. */
export interface Shortcut {
	key: string;
	text: string;
}

/** A row before its key is resolved: a pi binding (with its default) or a fixed key. */
interface RowSpec {
	text: string;
	binding?: string;
	key?: string;
	/** The key is pressed twice (`esc esc`). */
	twice?: boolean;
}

/** pi names keys `escape`, `up`, `down`; Claude Code's hints say `esc`, `↑`, `↓`. */
function displayKey(key: string): string {
	return key
		.split("/")
		.map((part) => (part === "escape" ? "esc" : part === "up" ? "↑" : part === "down" ? "↓" : part))
		.join("/");
}

function resolve(spec: RowSpec, sources: ShortcutSources): Shortcut | undefined {
	const raw = spec.binding ? boundKey(sources.keyText, spec.binding, spec.key ?? "") : (spec.key ?? null);
	if (!raw) return undefined;
	const key = displayKey(raw);
	return { key: spec.twice ? `${key} ${key}` : key, text: spec.text };
}

/**
 * The three columns: input prefixes, then the keys that change what is shown,
 * then the editing and session keys. A row whose key is unbound, or whose
 * command or editor feature is absent, is left out.
 */
export function shortcutColumns(sources: ShortcutSources): Shortcut[][] {
	const has = sources.hasCommand ?? (() => true);
	const editor = sources.editorKeys ?? {};
	const columns: (RowSpec | false)[][] = [
		[
			{ key: "!", text: "for shell mode" },
			{ key: "/", text: "for commands" },
			{ key: "@", text: "for file paths" },
			has("btw") && { key: "/btw", text: "for side question" },
		],
		[
			editor.clearInput === true && { binding: "app.interrupt", key: "escape", twice: true, text: "to clear input" },
			{ binding: "app.thinking.cycle", key: "shift+tab", text: "to change effort" },
			{ key: sources.modeCycleKey, text: "to cycle modes" },
			{ binding: "app.tools.expand", key: "ctrl+o", text: "to expand output" },
			{ binding: "app.thinking.toggle", key: "ctrl+t", text: "to show thinking" },
			{ key: sources.taskToggleKey, text: "to toggle tasks" },
			{ key: "\\ then enter", text: "for newline" },
			{ key: "↓", text: "to manage agents" },
		],
		[
			{ binding: "tui.editor.undo", key: "ctrl+-", text: "to undo" },
			{ binding: "app.suspend", key: "ctrl+z", text: "to suspend" },
			{ binding: "app.clipboard.pasteImage", key: "ctrl+v", text: "to paste images" },
			{ binding: "app.model.select", key: "ctrl+l", text: "to switch model" },
			editor.stash !== undefined && { key: editor.stash, text: "to stash prompt" },
			editor.historySearch !== undefined && { key: editor.historySearch, text: "to search history" },
			{ binding: "app.editor.external", key: "ctrl+g", text: "to edit in $EDITOR" },
			{ key: "ctrl+x ctrl+s", text: "to send now" },
			{ key: "ctrl+x ctrl+k", text: "to stop agents" },
			has("hotkeys") && { key: "/hotkeys", text: "for all keys" },
		],
	];
	return columns.map((column) => column.flatMap((spec) => (spec ? (resolve(spec, sources) ?? []) : [])));
}

/** Claude Code's indent and its first two columns' widths. */
const INDENT = 2;
const CC_WIDTHS = [24, 35];

const rowText = (row: Shortcut) => `${row.key} ${row.text}`;

/**
 * The columns as plain lines for `width` terminal columns. Claude Code's three
 * columns when they fit (each at least its Claude Code width, wider when a row
 * needs it); else every row in two columns, top to bottom; else one column,
 * each row cut with an ellipsis.
 */
export function shortcutLines(columns: Shortcut[][], width: number): string[] {
	const texts = columns.map((column) => column.map(rowText)).filter((column) => column.length > 0);
	const widest = (column: string[]) => column.reduce((max, text) => Math.max(max, visibleWidth(text)), 0);
	const indent = " ".repeat(INDENT);
	const grid = (cols: string[][], widths: number[]): string[] => {
		const height = Math.max(0, ...cols.map((column) => column.length));
		return Array.from({ length: height }, (_, row) => {
			const cells = cols.map((column, i) => (i < cols.length - 1 ? padPlainText(column[row] ?? "", widths[i] ?? 0) : (column[row] ?? "")));
			return `${indent}${cells.join("")}`.trimEnd();
		});
	};
	if (texts.length === 3) {
		const widths = [0, 1].map((i) => Math.max(CC_WIDTHS[i] ?? 0, widest(texts[i] ?? []) + 2));
		if (INDENT + (widths[0] ?? 0) + (widths[1] ?? 0) + widest(texts[2] ?? []) <= width) return grid(texts, widths);
	}
	const all = texts.flat();
	const half = Math.ceil(all.length / 2);
	const left = all.slice(0, half);
	const right = all.slice(half);
	const leftWidth = widest(left) + 2;
	if (right.length > 0 && INDENT + leftWidth + widest(right) <= width) return grid([left, right], [leftWidth]);
	return all.map((text) => `${indent}${cutPlainText(text, Math.max(1, width - INDENT))}`);
}
