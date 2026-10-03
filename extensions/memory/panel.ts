/**
 * Pure state, key decoding, and rendering for the `/memory` panel — Claude Code's
 * Memory picker: a titled list of the CLAUDE.md-family / AGENTS.md / ONECODE.md
 * files plus "Open auto-memory folder", with an Auto-memory status line and a
 * learn-more link. Enter opens the selected entry (in `$EDITOR`); Esc closes.
 * Above the list, where CC keeps its toggle rows (↑ from the first file
 * reaches them), One Code's "Config sources" row switches between the
 * Claude-compatible and independent modes (lib/config-mode.ts).
 *
 * Kept free of pi imports so the layout and navigation are unit-tested; the
 * extension owns repaint, the overlay, and the actual open.
 */

import type { MemoryEntry } from "./entries.ts";
import type { ConfigMode } from "../lib/config-mode.ts";
import { keyId } from "../lib/key-input.ts";

export const MEMORY_DOCS_URL = "https://github.com/IsuruMaduranga/one-code";

export interface MemoryPanelState {
	/** The selected entry; ignored while the config-sources row is selected. */
	cursor: number;
	onModeRow: boolean;
}

export function initialMemoryState(): MemoryPanelState {
	return { cursor: 0, onModeRow: false };
}

/** The mode this process runs in and the one saved for the next start. */
export interface ModeView {
	running: ConfigMode;
	saved: ConfigMode;
}

export const MODE_LABELS: Record<ConfigMode, string> = {
	"claude-compatible": "Claude-compatible",
	independent: "Independent",
};

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

export type MemoryEffect = { kind: "open"; entry: MemoryEntry } | { kind: "toggle-mode" } | { kind: "close" };

/** `withModeRow` adds the config-sources row above the list. */
export function applyMemoryKey(
	state: MemoryPanelState,
	key: MemoryKey,
	entries: readonly MemoryEntry[],
	withModeRow = false,
): MemoryEffect | undefined {
	switch (key.kind) {
		case "up":
			if (withModeRow && state.cursor === 0) state.onModeRow = true;
			state.cursor = Math.max(0, state.cursor - 1);
			return undefined;
		case "down":
			if (state.onModeRow) {
				state.onModeRow = false;
				return undefined;
			}
			state.cursor = Math.min(entries.length - 1, state.cursor + 1);
			return undefined;
		case "enter": {
			if (state.onModeRow) return { kind: "toggle-mode" };
			const entry = entries[state.cursor];
			return entry ? { kind: "open", entry } : undefined;
		}
		case "close":
			return { kind: "close" };
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
	input: { state: MemoryPanelState; entries: readonly MemoryEntry[]; width: number; height: number; mode?: ModeView },
	paint: PanelPaint,
): string[] {
	const { state, entries, height, mode } = input;

	const header = [paint.bold("Memory"), "", `  ${paint.fg("muted", "Auto-memory: on")}`];
	if (mode) header.push(renderModeRow(mode, state.onModeRow, paint));
	header.push("");
	const footer = [
		"",
		paint.fg("muted", `Learn more: ${MEMORY_DOCS_URL}`),
		"",
		paint.fg("muted", mode ? "Enter to open or switch · ↑ for config sources · Esc to close" : "Enter to open · Esc to close"),
	];

	const listCapacity = Math.max(1, height - header.length - footer.length);
	const start = scrollStart(state.cursor, entries.length, listCapacity);
	const rows: string[] = [];
	for (let i = start; i < Math.min(entries.length, start + listCapacity); i++) {
		rows.push(renderRow(entries[i], i, !state.onModeRow && i === state.cursor, paint));
	}

	return [...header, ...rows, ...footer];
}

/** "Config sources: <saved>", with "(from next start)" while it differs from the running mode. */
function renderModeRow(mode: ModeView, selected: boolean, paint: PanelPaint): string {
	const pending = mode.saved !== mode.running ? " (from next start)" : "";
	const left = `${selected ? "❯ " : "  "}Config sources: ${MODE_LABELS[mode.saved]}${pending}`;
	const pad = " ".repeat(Math.max(2, DESC_COL + 12 - left.length));
	const description = MODE_DESCRIPTIONS[mode.saved];
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
