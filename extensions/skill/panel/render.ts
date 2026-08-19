/**
 * /skills panel rendering (pure).
 *
 * Returns plain lines already cut to width; the wiring wraps them in a
 * memoized component and applies a final ANSI-aware truncate. Mirrors Claude
 * Code's Skills menu: one row per skill, a state glyph, token estimate, and
 * scope, with plugin skills shown locked (managed via /plugins). Only width-1
 * glyphs are used — cutPlainText counts code points, so a wide emoji would
 * under-measure and risk pi's overwide-line crash.
 */

import { cutPlainText, padPlainText } from "../../lib/tui-render.ts";
import type { SkillState } from "../../lib/skill-overrides.ts";
import { clampSkillsCursor, type SkillsPanelState, type SkillsRow, visibleRows } from "./state.ts";

export interface SkillsPaint {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface SkillsRenderInput {
	state: SkillsPanelState;
	rows: SkillsRow[];
	width: number;
	height: number;
	notice?: string;
}

const GLYPH: Record<SkillState, string> = { on: "✔", "name-only": "●", "user-only": "○", off: "✘" };
const LABEL: Record<SkillState, string> = { on: "on", "name-only": "name-only", "user-only": "user-only", off: "off" };
const COLOR: Record<SkillState, string> = { on: "success", "name-only": "accent", "user-only": "warning", off: "error" };
/** Width of the state column, sized to the longest label ("● name-only"). */
const STATE_WIDTH = 12;

function rowLine(row: SkillsRow, isCursor: boolean, paint: SkillsPaint, width: number): string {
	const marker = isCursor ? "❯ " : "  ";
	const suffix = row.locked ? ` · ${row.pluginName ?? "plugin"} · locked` : "";
	const meta = ` · ${row.scope} · ~${row.tokens} tok${suffix}`;
	const label = padPlainText(`${GLYPH[row.state]} ${LABEL[row.state]}`, STATE_WIDTH);
	const plainHead = `${marker}${label}${row.name}`;
	// One flat highlight for the cursor row, like the /plugins panel.
	if (isCursor) return paint.fg("accent", cutPlainText(plainHead + meta, width - 1));
	const color = row.locked ? "dim" : COLOR[row.state];
	// Cut the meta on the visible-length budget left after the head, then paint.
	const remaining = Math.max(0, width - 1 - [...plainHead].length);
	return `${marker}${paint.fg(color, label)}${row.name}${paint.fg("dim", cutPlainText(meta, remaining))}`;
}

/** Slide a window over the rows so the cursor stays visible within `budget` lines. */
function window<T>(items: T[], cursor: number, budget: number): { slice: T[]; start: number; more: number } {
	if (items.length <= budget) return { slice: items, start: 0, more: 0 };
	let start = Math.min(cursor, items.length - budget);
	if (cursor < start) start = cursor;
	if (cursor >= start + budget) start = cursor - budget + 1;
	start = Math.max(0, start);
	return { slice: items.slice(start, start + budget), start, more: items.length - (start + budget) };
}

export function renderSkillsPanel(input: SkillsRenderInput, paint: SkillsPaint): string[] {
	const { state, rows, width, height } = input;
	const visible = visibleRows(rows, state);
	clampSkillsCursor(state, visible);

	const out: string[] = [];
	out.push(` ${paint.bold("Skills")}`);
	const sortNote = state.sort === "state" ? "sorted by state" : "sorted by name";
	out.push(paint.fg("dim", cutPlainText(` ${rows.length} skill${rows.length === 1 ? "" : "s"} · ${sortNote} · enter/space to cycle, / to search, t to sort, Esc to close`, width - 1)));
	out.push("");
	const searchText = state.search ? `⌕ ${state.search}` : "⌕ Search skills…";
	out.push(state.search ? `  ${searchText}` : `  ${paint.fg("dim", searchText)}`);
	out.push("");

	// Reserve: header(2) + blank + search + blank already pushed = out.length;
	// leave room for the "more" line, notice, blank, and footer note.
	const footerReserve = 3 + (input.notice ? 1 : 0);
	const budget = Math.max(1, height - out.length - footerReserve);

	if (visible.length === 0) {
		out.push(paint.fg("dim", state.search ? "  No skills match your search." : "  No skills found."));
	} else {
		const win = window(visible, state.cursor, budget);
		for (let i = 0; i < win.slice.length; i++) {
			out.push(rowLine(win.slice[i], win.start + i === state.cursor, paint, width));
		}
		if (win.more > 0) out.push(paint.fg("dim", `  ↓ ${win.more} more`));
	}

	if (input.notice) out.push(paint.fg("warning", cutPlainText(`  ${input.notice}`, width - 1)));
	out.push("");
	out.push(paint.fg("dim", cutPlainText(" Plugin skills are managed via /plugins", width - 1)));
	return out;
}
