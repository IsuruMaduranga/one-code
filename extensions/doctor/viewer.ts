/**
 * The `/doctor` panel (pure): a read-only, scrollable view of the rendered
 * report inside `ctx.ui.custom`, with the key hints on screen (a hidden key is
 * an undiscoverable key). The wiring owns repaint and the fix/close effects.
 */

import { panelTopRule } from "../lib/tui-render.ts";

export interface DoctorViewerState {
	offset: number;
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
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
		case "k":
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
		case "j":
			return { kind: "down" };
		case "\x1b[5~":
		case "\x02": // ctrl+b
		case "b":
			return { kind: "pageUp" };
		case "\x1b[6~":
		case "\x06": // ctrl+f
		case " ":
			return { kind: "pageDown" };
		case "\x1b[H":
		case "\x1b[1~":
		case "g":
			return { kind: "home" };
		case "\x1b[F":
		case "\x1b[4~":
		case "G":
			return { kind: "end" };
		case "f":
			return { kind: "fix" };
		case "\x1b":
		case "\x03": // ctrl+c
		case "q":
		case "\r":
		case "\n":
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

/** Rows taken by the top rule and the footer hint. */
export const VIEWER_CHROME_ROWS = 3;

export function visibleBodyRows(height: number): number {
	return Math.max(1, height - VIEWER_CHROME_ROWS);
}

export function renderDoctorViewer(input: DoctorViewerInput, paint: (color: string, text: string) => string): string[] {
	const { lines, state, width, height } = input;
	const visible = visibleBodyRows(height);
	const max = Math.max(0, lines.length - visible);
	if (state.offset > max) state.offset = max;
	const window = lines.slice(state.offset, state.offset + visible);
	while (window.length < visible) window.push("");
	const position = lines.length > visible ? ` · ${state.offset + 1}-${Math.min(lines.length, state.offset + visible)} of ${lines.length}` : "";
	// PageUp/PageDown are pi-tui's own scrollback keys in fullscreen mode and never
	// reach a component, so the hint names keys that do.
	const hints = [`↑/↓ scroll · space/b page · g/G top/end${position}`, ...(input.canFix ? ["f run the checkup (the model fixes the findings)"] : []), "esc close"].join(" · ");
	return [panelTopRule(paint, width), ...window, "", paint("dim", ` ${hints}`)];
}
