/**
 * The `/doctor` panel (pure): a read-only, scrollable view of the rendered
 * report inside `ctx.ui.custom`, with the key hints on screen (a hidden key is
 * an undiscoverable key). The wiring owns repaint and the fix/close effects.
 */

import { panelTopRule, wrapHints } from "../lib/tui-render.ts";
import { keyId, keyText } from "../lib/key-input.ts";

export interface DoctorViewerState {
	offset: number;
	/** Body rows the last render showed (the hint row can wrap); the keys page by it. */
	visibleRows?: number;
}

export type DoctorViewerKey =
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "pageUp" }
	| { kind: "pageDown" }
	| { kind: "home" }
	| { kind: "end" }
	| { kind: "fix" }
	| { kind: "close" };

export function decodeDoctorKey(data: string): DoctorViewerKey | undefined {
	switch (keyId(data)) {
		case "up":
			return { kind: "up" };
		case "down":
			return { kind: "down" };
		case "pageUp":
		case "ctrl+b":
			return { kind: "pageUp" };
		case "pageDown":
		case "ctrl+f":
		case "space":
			return { kind: "pageDown" };
		case "home":
			return { kind: "home" };
		case "end":
			return { kind: "end" };
		case "escape":
		case "ctrl+c":
		case "enter":
			return { kind: "close" };
		default:
			break;
	}
	switch (keyText(data)) {
		case "k":
			return { kind: "up" };
		case "j":
			return { kind: "down" };
		case "b":
			return { kind: "pageUp" };
		case "g":
			return { kind: "home" };
		case "G":
			return { kind: "end" };
		case "f":
			return { kind: "fix" };
		case "q":
			return { kind: "close" };
		default:
			return undefined;
	}
}

export type DoctorViewerEffect = { kind: "fix" } | { kind: "close" };

/** Move the window; returns an effect for keys the wiring must act on. */
export function applyDoctorKey(state: DoctorViewerState, key: DoctorViewerKey, total: number, visible: number): DoctorViewerEffect | undefined {
	const max = Math.max(0, total - visible);
	const page = Math.max(1, visible - 1);
	switch (key.kind) {
		case "up":
			state.offset = Math.max(0, state.offset - 1);
			return undefined;
		case "down":
			state.offset = Math.min(max, state.offset + 1);
			return undefined;
		case "pageUp":
			state.offset = Math.max(0, state.offset - page);
			return undefined;
		case "pageDown":
			state.offset = Math.min(max, state.offset + page);
			return undefined;
		case "home":
			state.offset = 0;
			return undefined;
		case "end":
			state.offset = max;
			return undefined;
		case "fix":
			return { kind: "fix" };
		case "close":
			return { kind: "close" };
	}
}

export interface DoctorViewerInput {
	/** Already rendered (painted, width-cut) report lines. */
	lines: string[];
	state: DoctorViewerState;
	width: number;
	/** Total rows the panel may occupy, chrome included. */
	height: number;
	/** Whether a model is available, so the `f` hint is shown. */
	canFix: boolean;
}

/** Rows taken by the top rule, the blank above the hints and a one-line hint row. */
export const VIEWER_CHROME_ROWS = 3;

export function visibleBodyRows(height: number): number {
	return Math.max(1, height - VIEWER_CHROME_ROWS);
}

export function renderDoctorViewer(input: DoctorViewerInput, paint: (color: string, text: string) => string): string[] {
	const { lines, state, width, height } = input;
	// PageUp/PageDown are pi-tui's own scrollback keys in fullscreen mode and never
	// reach a component, so the hint names keys that do. On a narrow terminal the
	// hints wrap at their separators (so "esc close" is never the part cut off)
	// and the body gives up the rows; the position text depends on the body
	// height, so the layout settles in a second pass.
	const hintLines = (visible: number): string[] => {
		const max = Math.max(0, lines.length - visible);
		const offset = Math.min(state.offset, max);
		const position = lines.length > visible ? ` · ${offset + 1}-${Math.min(lines.length, offset + visible)} of ${lines.length}` : "";
		const hints = [`↑/↓ scroll · space/b page · g/G top/end${position}`, ...(input.canFix ? ["f run the checkup (the model fixes the findings)"] : []), "esc close"].join(" · ");
		return wrapHints(hints, Math.max(1, width - 1));
	};
	let visible = visibleBodyRows(height);
	let footer = hintLines(visible);
	if (footer.length > 1) {
		visible = Math.max(1, visible - (footer.length - 1));
		footer = hintLines(visible);
	}
	state.visibleRows = visible;
	const max = Math.max(0, lines.length - visible);
	if (state.offset > max) state.offset = max;
	const window = lines.slice(state.offset, state.offset + visible);
	while (window.length < visible) window.push("");
	return [panelTopRule(paint, width), ...window, "", ...footer.map((line) => paint("dim", ` ${line}`))];
}
