/**
 * Pure state, key decoding, and rendering for the `/memory` panel — Claude Code's
 * Memory picker: a titled list of the CLAUDE.md-family / AGENTS.md / ONECODE.md
 * files plus "Open auto-memory folder", with an Auto-memory status line and a
 * learn-more link. Enter opens the selected entry (in `$EDITOR`); Esc closes.
 * Above the list, where CC keeps its toggle rows (↑ from the first file
 * reaches them): CC's "Auto-memory" toggle (lib/auto-memory.ts), then the
 * source provider's switch when the profile has one (lib/sources.ts; One
 * Code's "Config sources", Claude-compatible or independent), which switches
 * after a confirmation, since it changes every place configuration is read
 * from.
 *
 * Kept free of pi imports so the layout and navigation are unit-tested; the
 * extension owns repaint, the overlay, and the actual open.
 */

import type { MemoryEntry } from "./entries.ts";
import type { SourceSwitch } from "../lib/sources.ts";
import { keyId } from "../lib/key-input.ts";
import { wrapHints, wrapProse } from "../lib/tui-render.ts";

export const MEMORY_DOCS_URL = "https://github.com/IsuruMaduranga/one-code";

/** Cursor rows above the list: the switch's row just above it, when there is one, and auto-memory above that. */
export const CONFIG_SOURCES_ROW = -1;
const autoMemoryRow = (hasMode: boolean): number => (hasMode ? -2 : -1);

export interface MemoryPanelState {
	/** The selected entry's index; the two toggle rows above the list are negative. */
	cursor: number;
	/** Set while the config-sources switch waits for a second Enter. */
	confirmingMode?: boolean;
}

export function initialMemoryState(): MemoryPanelState {
	return { cursor: 0 };
}

/** A setting's value in this process, the value saved for the next start, and whether an env variable sets it. */
export interface SettingView<T> {
	running: T;
	saved: T;
	fromEnv?: boolean;
}

/** Auto-memory; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` can set it. */
export type AutoMemoryView = SettingView<boolean>;

/** The source provider's switch, true while the provider is on; its environment variable can set it. */
export interface ModeView extends SettingView<boolean> {
	switch: Pick<SourceSwitch, "title" | "key" | "envVar" | "on" | "off">;
}

/** The label and what is read for the switch in `on`. */
const switchState = (mode: ModeView, on: boolean) => (on ? mode.switch.on : mode.switch.off);

/** "; applies from the next start" while the saved value differs from the running one. */
const pendingSuffix = (view: SettingView<unknown>): string => (view.saved === view.running ? "" : "; applies from the next start");

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
 * Enter on the switch's row asks first (`confirm-mode`); a second Enter
 * switches (`toggle-mode`), and Esc or a move keeps the mode and the panel.
 * "Auto-memory" toggles at once, as in Claude Code.
 */
export function applyMemoryKey(state: MemoryPanelState, key: MemoryKey, entries: readonly MemoryEntry[], hasMode = true): MemoryEffect | undefined {
	const confirming = state.confirmingMode === true;
	state.confirmingMode = false;
	switch (key.kind) {
		case "up":
			state.cursor = Math.max(autoMemoryRow(hasMode), state.cursor - 1);
			return undefined;
		case "down":
			state.cursor = Math.min(entries.length - 1, state.cursor + 1);
			return undefined;
		case "enter": {
			if (state.cursor === autoMemoryRow(hasMode)) return { kind: "toggle-auto-memory" };
			if (hasMode && state.cursor === CONFIG_SOURCES_ROW) {
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
		/** The source provider's switch; no row without one. */
		mode?: ModeView;
		autoMemory?: AutoMemoryView;
	},
	paint: PanelPaint,
): string[] {
	const { state, entries, height, mode, width } = input;
	const autoMemory = input.autoMemory ?? { running: true, saved: true };

	const header = [
		paint.bold("Memory"),
		"",
		renderAutoMemoryRow(autoMemory, state.cursor === autoMemoryRow(mode !== undefined), paint),
		...(mode ? [renderModeRow(mode, state.cursor === CONFIG_SOURCES_ROW, paint)] : []),
		"",
	];
	const hints =
		state.confirmingMode && mode
			? [
					...wrapProse(modeConfirmQuestion(mode), Math.max(20, width)).map((line) => paint.fg("warning", line)),
					...wrapHints(`Enter to switch · Esc to keep ${switchState(mode, mode.saved).label}`, width).map((line) => paint.fg("muted", line)),
				]
			: wrapHints(`Enter to open or toggle · ↑ for auto-memory${mode ? ` and ${mode.switch.title.toLowerCase()}` : ""} · Esc to close`, width).map((line) => paint.fg("muted", line));
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
export function settingChanges(before: { mode?: boolean; autoMemory: boolean }, mode: ModeView | undefined, autoMemory: AutoMemoryView): string {
	const lines: string[] = [];
	if (autoMemory.saved !== before.autoMemory) {
		lines.push(`Turned auto-memory ${autoMemory.saved ? "on" : "off"}${pendingSuffix(autoMemory)}`);
	}
	if (mode && mode.saved !== before.mode) {
		lines.push(`Set ${mode.switch.title.toLowerCase()} to ${switchState(mode, mode.saved).label}${pendingSuffix(mode)}`);
	}
	return lines.join("\n");
}

/** The question the config-sources confirmation asks. */
export function modeConfirmQuestion(mode: ModeView): string {
	const next = switchState(mode, !mode.saved);
	return `Switch ${mode.switch.title.toLowerCase()} to ${next.label}? One Code will read ${next.reads} instead, from the next start.`;
}

/**
 * A toggle row's plain text, "<label>: <saved>", with "(from next start)" while
 * the saved value differs from the running one; when `envName` sets it, the
 * running value and that it is set there. Also returns the value shown.
 */
function settingRow<T>(label: string, view: SettingView<T>, valueText: (value: T) => string, envName: string, selected: boolean): { left: string; shown: T } {
	const shown = view.fromEnv ? view.running : view.saved;
	const note = view.fromEnv ? ` (set by ${envName})` : view.saved !== view.running ? " (from next start)" : "";
	return { left: `${selected ? "❯ " : "  "}${label}: ${valueText(shown)}${note}`, shown };
}

/** "Auto-memory: on|off". */
function renderAutoMemoryRow(view: AutoMemoryView, selected: boolean, paint: PanelPaint): string {
	const { left } = settingRow("Auto-memory", view, (on) => (on ? "on" : "off"), "CLAUDE_CODE_DISABLE_AUTO_MEMORY", selected);
	return selected ? paint.fg("accent", left) : left;
}

/** "Config sources: <mode>" and the mode's description. */
function renderModeRow(mode: ModeView, selected: boolean, paint: PanelPaint): string {
	const { left, shown } = settingRow(mode.switch.title, mode, (on) => switchState(mode, on).label, mode.switch.envVar, selected);
	const pad = " ".repeat(Math.max(2, DESC_COL + 12 - left.length));
	const description = switchState(mode, shown).reads;
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
