/**
 * /mcp panel state machine (pure).
 *
 * Two views: the server list (cursor over entries; group headings are
 * render-only and never landed on) and the detail view for one server (cursor
 * over its numbered action list). `applyMcpKey` mutates the state in place and
 * returns an effect when a key demands I/O — reconnect, disable, enable,
 * authenticate — which the wiring performs and reflects back through the entries
 * it renders. The wiring passes the current entries so "the selected row" always
 * matches what was drawn (async reconnects reorder the list).
 */

import type { McpKey } from "./keys.ts";
import { actionsFor, type McpEntry } from "./model.ts";

export interface McpPanelState {
	cursor: number;
	detail?: { name: string; actionCursor: number };
}

export type McpEffect =
	| { kind: "close" }
	| { kind: "reconnect"; entry: McpEntry }
	| { kind: "disable"; entry: McpEntry }
	| { kind: "enable"; entry: McpEntry }
	| { kind: "authenticate"; entry: McpEntry };

export function initialMcpState(): McpPanelState {
	return { cursor: 0 };
}

export function clampMcpCursor(state: McpPanelState, entries: McpEntry[]): void {
	state.cursor = entries.length === 0 ? 0 : Math.max(0, Math.min(state.cursor, entries.length - 1));
}

/** Resolve the detail view's entry against the current list (rows shift under async work). */
export function detailEntry(state: McpPanelState, entries: McpEntry[]): McpEntry | undefined {
	return state.detail ? entries.find((entry) => entry.name === state.detail!.name) : undefined;
}

function effectForAction(entry: McpEntry, index: number): McpEffect | undefined {
	const action = actionsFor(entry)[index];
	if (!action) return undefined;
	switch (action.key) {
		case "reconnect":
			return { kind: "reconnect", entry };
		case "disable":
			return { kind: "disable", entry };
		case "enable":
			return { kind: "enable", entry };
		case "authenticate":
			return { kind: "authenticate", entry };
	}
}

export function applyMcpKey(state: McpPanelState, key: McpKey, entries: McpEntry[]): McpEffect | undefined {
	// Detail view.
	if (state.detail) {
		const entry = detailEntry(state, entries);
		if (!entry) {
			// The server vanished (e.g. config changed under an async refresh).
			if (key.kind === "back" || key.kind === "enter") state.detail = undefined;
			if (key.kind === "close") return { kind: "close" };
			return undefined;
		}
		const actions = actionsFor(entry);
		const detail = state.detail;
		detail.actionCursor = Math.max(0, Math.min(detail.actionCursor, actions.length - 1));
		switch (key.kind) {
			case "up":
				detail.actionCursor = Math.max(0, detail.actionCursor - 1);
				return undefined;
			case "down":
				detail.actionCursor = Math.min(actions.length - 1, detail.actionCursor + 1);
				return undefined;
			case "enter":
				return effectForAction(entry, detail.actionCursor);
			case "digit":
				return effectForAction(entry, key.value - 1);
			case "back":
				state.detail = undefined;
				return undefined;
			case "close":
				return { kind: "close" };
		}
	}

	// List view.
	clampMcpCursor(state, entries);
	switch (key.kind) {
		case "up":
			state.cursor = Math.max(0, state.cursor - 1);
			return undefined;
		case "down":
			state.cursor = Math.min(Math.max(0, entries.length - 1), state.cursor + 1);
			return undefined;
		case "enter": {
			const entry = entries[state.cursor];
			if (entry) state.detail = { name: entry.name, actionCursor: 0 };
			return undefined;
		}
		case "back":
		case "close":
			return { kind: "close" };
		case "digit":
			return undefined;
	}
}
