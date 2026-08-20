/**
 * Pure state, key decoding, and rendering for the `/memory` panel — Claude Code's
 * Memory picker: a titled list of the CLAUDE.md-family / AGENTS.md / ONECODE.md
 * files plus "Open auto-memory folder", with an Auto-memory status line and a
 * learn-more link. Enter opens the selected entry (in `$EDITOR`); Esc closes.
 *
 * Kept free of pi imports so the layout and navigation are unit-tested; the
 * extension owns repaint, the overlay, and the actual open.
 */

import type { MemoryEntry } from "./entries.ts";

export const MEMORY_DOCS_URL = "https://github.com/IsuruMaduranga/one-code";

export interface MemoryPanelState {
	cursor: number;
}

export function initialMemoryState(): MemoryPanelState {
	return { cursor: 0 };
}

export type MemoryKey = { kind: "up" | "down" | "enter" | "close" };

export function decodeMemoryKey(data: string): MemoryKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
		case "\x10": // ctrl+p
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
		case "\x0e": // ctrl+n
			return { kind: "down" };
		case "\r":
		case "\n":
			return { kind: "enter" };
		case "\x1b":
		case "\x03": // ctrl+c
			return { kind: "close" };
		default:
			return undefined;
	}
}

export type MemoryEffect = { kind: "open"; entry: MemoryEntry } | { kind: "close" };

export function applyMemoryKey(
	state: MemoryPanelState,
	key: MemoryKey,
	entries: readonly MemoryEntry[],
): MemoryEffect | undefined {
	switch (key.kind) {
		case "up":
			state.cursor = Math.max(0, state.cursor - 1);
			return undefined;
		case "down":
			state.cursor = Math.min(entries.length - 1, state.cursor + 1);
			return undefined;
		case "enter": {
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
	input: { state: MemoryPanelState; entries: readonly MemoryEntry[]; width: number; height: number; notice?: string },
	paint: PanelPaint,
): string[] {
	const { state, entries, height, notice } = input;

	const header = [paint.bold("Memory"), "", `  ${paint.fg("muted", "Auto-memory: on")}`, ""];
	const footer = [
		"",
		paint.fg("muted", `Learn more: ${MEMORY_DOCS_URL}`),
		"",
		paint.fg("muted", notice ?? "Enter to open · Esc to close"),
	];

	const listCapacity = Math.max(1, height - header.length - footer.length);
	const start = scrollStart(state.cursor, entries.length, listCapacity);
	const rows: string[] = [];
	for (let i = start; i < Math.min(entries.length, start + listCapacity); i++) {
		rows.push(renderRow(entries[i], i, i === state.cursor, paint));
	}

	return [...header, ...rows, ...footer];
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
