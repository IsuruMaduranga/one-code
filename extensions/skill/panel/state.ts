/**
 * /skills panel state machine (pure — no pi, no fs).
 *
 * The wiring (skill/index.ts) builds the row list from disk each repaint and
 * owns persistence; this module owns cursor/search/sort and turns keys into
 * effects. Filtering and sorting are pure functions over the row list so the
 * renderer and the key handler agree on what "the selected row" is.
 */

import type { SkillScope, SkillState } from "../../lib/skill-overrides.ts";
import type { SkillsKey } from "./keys.ts";

export interface SkillsRow {
	/** Override-store key, `<scope>:<name>`. */
	key: string;
	name: string;
	scope: SkillScope;
	tokens: number;
	/** Current state; for locked (plugin) rows this is the effective on/off. */
	state: SkillState;
	/** Plugin/MCP skills can't be cycled here — managed via /plugins. */
	locked: boolean;
	pluginName?: string;
}

export type SkillsSort = "name" | "state";

export interface SkillsPanelState {
	cursor: number;
	search: string;
	searching: boolean;
	sort: SkillsSort;
}

export type SkillsEffect = { kind: "close" } | { kind: "cycle"; row: SkillsRow } | { kind: "locked"; row: SkillsRow };

export function initialSkillsState(): SkillsPanelState {
	return { cursor: 0, search: "", searching: false, sort: "name" };
}

/** State-sort order groups by availability, most-available first, locked last. */
const STATE_ORDER: Record<SkillState, number> = { on: 0, "name-only": 1, "user-only": 2, off: 3 };

export function visibleRows(rows: SkillsRow[], state: SkillsPanelState): SkillsRow[] {
	const query = state.search.trim().toLowerCase();
	const filtered = query ? rows.filter((row) => row.name.toLowerCase().includes(query)) : rows.slice();
	const rank = (row: SkillsRow) => (row.locked ? 4 : STATE_ORDER[row.state]);
	filtered.sort((a, b) => {
		if (state.sort === "state") {
			const diff = rank(a) - rank(b);
			if (diff !== 0) return diff;
		}
		return a.name.localeCompare(b.name);
	});
	return filtered;
}

export function clampSkillsCursor(state: SkillsPanelState, visible: SkillsRow[]): void {
	if (visible.length === 0) {
		state.cursor = 0;
		return;
	}
	state.cursor = Math.max(0, Math.min(state.cursor, visible.length - 1));
}

/**
 * Fold a key into the state, returning an effect the wiring must act on. The
 * caller passes the already-filtered/sorted rows so "the selected row" matches
 * what the renderer drew.
 */
export function applySkillsKey(state: SkillsPanelState, key: SkillsKey, visible: SkillsRow[]): SkillsEffect | undefined {
	clampSkillsCursor(state, visible);
	switch (key.kind) {
		case "close":
			return { kind: "close" };
		case "up":
			state.cursor = Math.max(0, state.cursor - 1);
			return;
		case "down":
			state.cursor = Math.min(Math.max(0, visible.length - 1), state.cursor + 1);
			return;
		case "space":
		case "enter": {
			const row = visible[state.cursor];
			if (!row) return;
			return row.locked ? { kind: "locked", row } : { kind: "cycle", row };
		}
		case "backspace":
			if (state.searching) state.search = state.search.slice(0, -1);
			return;
		case "back":
			// Esc leaves search first, then closes the panel.
			if (state.searching || state.search) {
				state.searching = false;
				state.search = "";
				return;
			}
			return { kind: "close" };
		case "text": {
			if (!state.searching) {
				if (key.text === "/") {
					state.searching = true;
					return;
				}
				if (key.text === "t") {
					state.sort = state.sort === "name" ? "state" : "name";
					return;
				}
				return;
			}
			state.search += key.text;
			return;
		}
	}
}
