/**
 * Pure state, key decoding, and rendering for the `/memory` panel — Claude Code's
 * Memory picker: a titled list of the CLAUDE.md-family / AGENTS.md / ONECODE.md
 * files plus "Open auto-memory folder", with an Auto-memory status line and a
 * learn-more link. Enter opens the selected entry (in `$EDITOR`); Esc closes.
 * Above the list, where CC keeps its toggle rows (↑ from the first file
 * reaches them): CC's "Auto-memory" toggle (lib/auto-memory.ts), then One
 * Code's "Config sources" row, which switches between the Claude-compatible
 * and independent modes (lib/config-mode.ts) after a confirmation, since it
 * changes every place configuration is read from.
 *
 * Kept free of pi imports so the layout and navigation are unit-tested; the
 * extension owns repaint, the overlay, and the actual open.
 */

import type { MemoryEntry } from "./entries.ts";
import { type ConfigMode, MODE_LABELS } from "../lib/config-mode.ts";
import { keyId } from "../lib/key-input.ts";
import { wrapHints, wrapProse } from "../lib/tui-render.ts";

export const MEMORY_DOCS_URL = "https://github.com/IsuruMaduranga/one-code";

/** Cursor rows above the list. */
export const AUTO_MEMORY_ROW = -2;
export const CONFIG_SOURCES_ROW = -1;

export interface MemoryPanelState {
	/** The selected entry's index; the two toggle rows above the list are negative. */
	cursor: number;
	/** Set while the config-sources switch waits for a second Enter. */
	confirmingMode?: boolean;
}

export function initialMemoryState(): MemoryPanelState {
	return { cursor: 0 };
}

/** Auto-memory for this process, the value saved for the next start, and whether the env variable sets it. */
export interface AutoMemoryView {
	running: boolean;
	saved: boolean;
	fromEnv?: boolean;
}

/** The mode this process runs in, the one saved for the next start, and whether `ONECODE_CONFIG_MODE` sets it. */
export interface ModeView {
	running: ConfigMode;
	saved: ConfigMode;
	fromEnv?: boolean;
}

const MODE_DESCRIPTIONS: Record<ConfigMode, string> = {
	"claude-compatible": "~/.claude, CLAUDE.md, .agents and pi's dirs",
	independent: "~/.onecode, ONECODE.md, .agents and pi's dirs",
};

export type MemoryKey = { kind: "up" | "down" | "enter" | "close" };

export function decodeMemoryKey(data: string): MemoryKey | undefined {
	switch (keyId(data)) {
		case "up":
		case "ctrl+p":
			return { kind: "up" };
		case "down":
		case "ctrl+n":
			return { kind: "down" };
		case "enter":
			return { kind: "enter" };
		case "escape":
		case "ctrl+c":
			return { kind: "close" };
		default:
			return undefined;
	}
}

export type MemoryEffect =
	| { kind: "open"; entry: MemoryEntry }
	| { kind: "confirm-mode" }
	| { kind: "toggle-mode" }
	| { kind: "toggle-auto-memory" }
	| { kind: "close" };

/**
 * Enter on "Config sources" asks first (`confirm-mode`); a second Enter
 * switches (`toggle-mode`), and Esc or a move keeps the mode and the panel.
 * "Auto-memory" toggles at once, as in Claude Code.
 */
export function applyMemoryKey(state: MemoryPanelState, key: MemoryKey, entries: readonly MemoryEntry[]): MemoryEffect | undefined {
	const confirming = state.confirmingMode === true;
	state.confirmingMode = false;
	switch (key.kind) {
		case "up":
			state.cursor = Math.max(AUTO_MEMORY_ROW, state.cursor - 1);
			return undefined;
		case "down":
			state.cursor = Math.min(entries.length - 1, state.cursor + 1);
			return undefined;
		case "enter": {
			if (state.cursor === AUTO_MEMORY_ROW) return { kind: "toggle-auto-memory" };
			if (state.cursor === CONFIG_SOURCES_ROW) {
				if (confirming) return { kind: "toggle-mode" };
				state.confirmingMode = true;
				return { kind: "confirm-mode" };
			}
			const entry = entries[state.cursor];
			return entry ? { kind: "open", entry } : undefined;
		}
		case "close":
			// Esc on the confirmation keeps the mode and the panel.
			return confirming ? undefined : { kind: "close" };
	}
}

export type PanelPaint = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

/** Column where descriptions begin (after "❯ N. Title"), padded on plain text. */
const DESC_COL = 34;

/**
 * Render the panel to `height` lines. The header (title, status) and footer
 * (learn-more, key hints) are fixed; the entry list scrolls within what's left so
 * the cursor stays visible.
 */
export function renderMemoryPanel(
	input: {
		state: MemoryPanelState;
		entries: readonly MemoryEntry[];
		width: number;
		height: number;
		mode: ModeView;
		autoMemory?: AutoMemoryView;
	},
	paint: PanelPaint,
): string[] {
	const { state, entries, height, mode, width } = input;
	const autoMemory = input.autoMemory ?? { running: true, saved: true };

	const header = [
		paint.bold("Memory"),
		"",
		renderAutoMemoryRow(autoMemory, state.cursor === AUTO_MEMORY_ROW, paint),
		renderModeRow(mode, state.cursor === CONFIG_SOURCES_ROW, paint),
		"",
	];
	const hints = state.confirmingMode
		? [
				...wrapProse(modeConfirmQuestion(mode), Math.max(20, width)).map((line) => paint.fg("warning", line)),
				...wrapHints(`Enter to switch · Esc to keep ${MODE_LABELS[mode.saved]}`, width).map((line) => paint.fg("muted", line)),
			]
		: wrapHints("Enter to open or toggle · ↑ for auto-memory and config sources · Esc to close", width).map((line) => paint.fg("muted", line));
	const footer = ["", paint.fg("muted", `Learn more: ${MEMORY_DOCS_URL}`), "", ...hints];

	const listCapacity = Math.max(1, height - header.length - footer.length);
	const start = scrollStart(Math.max(0, state.cursor), entries.length, listCapacity);
	const rows: string[] = [];
	for (let i = start; i < Math.min(entries.length, start + listCapacity); i++) {
		rows.push(renderRow(entries[i], i, i === state.cursor, paint));
	}

	return [...header, ...rows, ...footer];
}

/**
 * One line per toggle the panel changed (the result `/memory` reports), empty
 * when nothing changed.
 */
export function settingChanges(before: { mode: ConfigMode; autoMemory: boolean }, mode: ModeView, autoMemory: AutoMemoryView): string {
	const lines: string[] = [];
	if (autoMemory.saved !== before.autoMemory) {
		lines.push(`Turned auto-memory ${autoMemory.saved ? "on" : "off"}${autoMemory.saved === autoMemory.running ? "" : "; applies from the next start"}`);
	}
	if (mode.saved !== before.mode) {
		lines.push(`Set config sources to ${MODE_LABELS[mode.saved]}${mode.saved === mode.running ? "" : "; applies from the next start"}`);
	}
	return lines.join("\n");
}

/** The question the config-sources confirmation asks. */
export function modeConfirmQuestion(mode: ModeView): string {
	const next: ConfigMode = mode.saved === "independent" ? "claude-compatible" : "independent";
	return `Switch config sources to ${MODE_LABELS[next]}? One Code will read ${MODE_DESCRIPTIONS[next]} instead, from the next start.`;
}

/** "Auto-memory: on|off", with the same pending and env notes as the mode row. */
function renderAutoMemoryRow(view: AutoMemoryView, selected: boolean, paint: PanelPaint): string {
	const shown = view.fromEnv ? view.running : view.saved;
	const note = view.fromEnv ? " (set by CLAUDE_CODE_DISABLE_AUTO_MEMORY)" : view.saved !== view.running ? " (from next start)" : "";
	const left = `${selected ? "❯ " : "  "}Auto-memory: ${shown ? "on" : "off"}${note}`;
	return selected ? paint.fg("accent", left) : left;
}

/**
 * "Config sources: <saved>", with "(from next start)" while it differs from the
 * running mode; under `ONECODE_CONFIG_MODE`, the running mode and that it is set there.
 */
function renderModeRow(mode: ModeView, selected: boolean, paint: PanelPaint): string {
	const shown = mode.fromEnv ? mode.running : mode.saved;
	const note = mode.fromEnv ? " (set by ONECODE_CONFIG_MODE)" : mode.saved !== mode.running ? " (from next start)" : "";
	const left = `${selected ? "❯ " : "  "}Config sources: ${MODE_LABELS[shown]}${note}`;
	const pad = " ".repeat(Math.max(2, DESC_COL + 12 - left.length));
	const description = MODE_DESCRIPTIONS[shown];
	return selected ? `${paint.fg("accent", left)}${pad}${paint.fg("accent", description)}` : `${left}${pad}${paint.fg("muted", description)}`;
}

/** First index to show so `cursor` is within a `capacity`-tall window. */
function scrollStart(cursor: number, total: number, capacity: number): number {
	if (total <= capacity) return 0;
	const start = Math.min(Math.max(0, cursor - Math.floor(capacity / 2)), total - capacity);
	return Math.max(0, start);
}

function renderRow(entry: MemoryEntry, index: number, selected: boolean, paint: PanelPaint): string {
	const prefix = selected ? "❯ " : "  ";
	const left = `${prefix}${index + 1}. ${entry.title}`;
	if (!entry.description) {
		return selected ? paint.fg("accent", left) : left;
	}
	const pad = " ".repeat(Math.max(2, DESC_COL - left.length + 2));
	if (selected) {
		return `${paint.fg("accent", left)}${pad}${paint.fg("accent", entry.description)}`;
	}
	return `${left}${pad}${paint.fg("muted", entry.description)}`;
}
