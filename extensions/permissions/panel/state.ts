/**
 * /permissions panel state machine (pure), Claude Code's panel (findings §33).
 *
 * `applyPanelKey` mutates the state in place (the wiring owns the object and
 * repaints after every key) and returns an effect when the key needs I/O:
 * saving or deleting a rule, or closing the panel, at which point the wiring
 * reads the approvals and retries off the state.
 *
 * Key routing, as in Claude Code:
 * - Recently denied: Enter toggles approval, `r` toggles retry (which also
 *   approves). Both act only when the panel closes.
 * - Allow / Ask / Deny: Enter opens the selected row (`Add a new rule…`, or a
 *   rule's detail and delete confirmation). Typing any printable key except
 *   `j k m i r` and space starts a search with that key, `/` starts an empty
 *   one; `j`/`k` move the cursor. Backspace edits the search, Esc clears it.
 * - ←/→ and Tab switch tabs everywhere outside a dialog; Esc closes the panel.
 */

import type { PanelKey } from "./keys.ts";

export type Tab = "recent" | "allow" | "ask" | "deny";
export const TABS: Tab[] = ["recent", "allow", "ask", "deny"];
export type RuleTab = "allow" | "ask" | "deny";
export const RULE_TABS: RuleTab[] = ["allow", "ask", "deny"];

export interface DenialRow {
	id: number;
	display: string;
	/** The grounded rule name, shown dim after the call. */
	rule?: string;
}

export interface RuleRow {
	/** Unique within its tab: the source file and the rule text. */
	key: string;
	behavior: RuleTab;
	raw: string;
	/** `From One Code user settings (~/.onecode/settings.json)`. */
	sourceLabel: string;
	/** Only One Code's own files (and this session's grants) can be edited here. */
	editable: boolean;
	/** Why an uneditable rule cannot be changed here, and where to change it. */
	readOnlyNote?: string;
}

export interface Destination {
	id: string;
	label: string;
	description: string;
}

export interface PanelView {
	denials: DenialRow[];
	/** Each tab's rules, already sorted. */
	rules: Record<RuleTab, RuleRow[]>;
	/** Where a new rule can be saved, first one first. */
	destinations: Destination[];
	/** Why a typed rule cannot be saved, or undefined when it parses. */
	ruleError: (raw: string) => string | undefined;
}

export type Dialog =
	| { kind: "addRule"; behavior: RuleTab; draft: string }
	| { kind: "saveRule"; behavior: RuleTab; rule: string; cursor: number }
	| { kind: "ruleDetail"; behavior: RuleTab; key: string; cursor: number };

export interface PanelState {
	tab: Tab;
	cursor: Record<Tab, number>;
	search: Record<RuleTab, string>;
	/** A rule tab's search box has the keyboard (typed text feeds it). */
	searching: boolean;
	/** Denial ids marked approved (✔). */
	approved: Set<number>;
	/** Denial ids marked for retry; each is also approved. */
	retry: Set<number>;
	dialog?: Dialog;
	notice?: string;
}

export type PanelEffect =
	| { kind: "close" }
	| { kind: "addRule"; behavior: RuleTab; rule: string; destination: string }
	| { kind: "deleteRule"; behavior: RuleTab; key: string };

export type RuleListRow = { kind: "add" } | { kind: "rule"; rule: RuleRow };

export function initialPanelState(hasDenials: boolean): PanelState {
	return {
		// Claude Code opens on Recently denied when there is something to act on.
		tab: hasDenials ? "recent" : "allow",
		cursor: { recent: 0, allow: 0, ask: 0, deny: 0 },
		search: { allow: "", ask: "", deny: "" },
		searching: false,
		approved: new Set(),
		retry: new Set(),
	};
}

export const isRuleTab = (tab: Tab): tab is RuleTab => (RULE_TABS as Tab[]).includes(tab);

/** A rule tab's rows: `Add a new rule…` (hidden while a query filters the list), then the matching rules. */
export function ruleListRows(state: PanelState, view: PanelView, tab: RuleTab): RuleListRow[] {
	const query = state.search[tab].toLowerCase();
	const rules = view.rules[tab].filter((rule) => !query || rule.raw.toLowerCase().includes(query)).map((rule) => ({ kind: "rule" as const, rule }));
	return query ? rules : [{ kind: "add" }, ...rules];
}

function rowCount(state: PanelState, view: PanelView): number {
	return isRuleTab(state.tab) ? ruleListRows(state, view, state.tab).length : view.denials.length;
}

export function clampPanelState(state: PanelState, view: PanelView): void {
	const max = Math.max(0, rowCount(state, view) - 1);
	state.cursor[state.tab] = Math.min(Math.max(0, state.cursor[state.tab]), max);
	if (state.dialog?.kind === "saveRule") {
		state.dialog.cursor = Math.min(Math.max(0, state.dialog.cursor), Math.max(0, view.destinations.length - 1));
	}
}

/** The rule a detail dialog shows, resolved against the current view (it may have been reloaded). */
export function detailRule(dialog: Extract<Dialog, { kind: "ruleDetail" }>, view: PanelView): RuleRow | undefined {
	return view.rules[dialog.behavior].find((rule) => rule.key === dialog.key);
}

const toggle = (set: Set<number>, id: number): boolean => {
	if (set.delete(id)) return false;
	set.add(id);
	return true;
};

/** Keys that do not start a search in Claude Code (vim navigation, reserved letters, space). */
const NO_SEARCH_KEYS = new Set(["j", "k", "m", "i", "r", " "]);

function applyDialogKey(state: PanelState, dialog: Dialog, key: PanelKey, view: PanelView): PanelEffect | undefined {
	if (key.kind === "close") return { kind: "close" };
	switch (dialog.kind) {
		case "addRule": {
			if (key.kind === "text") dialog.draft += key.text;
			else if (key.kind === "backspace") dialog.draft = dialog.draft.slice(0, -1);
			else if (key.kind === "back") state.dialog = undefined;
			else if (key.kind === "enter") {
				const rule = dialog.draft.trim();
				if (!rule) return undefined;
				const error = view.ruleError(rule);
				if (error) state.notice = error;
				else state.dialog = { kind: "saveRule", behavior: dialog.behavior, rule, cursor: 0 };
			}
			return undefined;
		}
		case "saveRule": {
			if (key.kind === "up") dialog.cursor = Math.max(0, dialog.cursor - 1);
			else if (key.kind === "down") dialog.cursor = Math.min(view.destinations.length - 1, dialog.cursor + 1);
			else if (key.kind === "back") state.dialog = { kind: "addRule", behavior: dialog.behavior, draft: dialog.rule };
			else if (key.kind === "enter") {
				const destination = view.destinations[dialog.cursor];
				state.dialog = undefined;
				if (destination) return { kind: "addRule", behavior: dialog.behavior, rule: dialog.rule, destination: destination.id };
			}
			return undefined;
		}
		case "ruleDetail": {
			const rule = detailRule(dialog, view);
			if (!rule || key.kind === "back") {
				state.dialog = undefined;
				return undefined;
			}
			if (!rule.editable) {
				if (key.kind === "enter") state.dialog = undefined;
				return undefined;
			}
			// Yes / No, as in Claude Code's delete confirmation.
			if (key.kind === "up" || key.kind === "down") dialog.cursor = dialog.cursor === 0 ? 1 : 0;
			else if (key.kind === "text" && /^[yn]$/i.test(key.text)) dialog.cursor = key.text.toLowerCase() === "y" ? 0 : 1;
			else if (key.kind === "enter") {
				state.dialog = undefined;
				if (dialog.cursor === 0) return { kind: "deleteRule", behavior: dialog.behavior, key: dialog.key };
			}
			return undefined;
		}
	}
}

export function applyPanelKey(state: PanelState, key: PanelKey, view: PanelView): PanelEffect | undefined {
	state.notice = undefined;
	if (state.dialog) return applyDialogKey(state, state.dialog, key, view);

	const tab = state.tab;
	const move = (step: number) => {
		state.cursor[tab] += step;
		clampPanelState(state, view);
	};

	switch (key.kind) {
		case "close":
			return { kind: "close" };
		case "back":
			if (isRuleTab(tab) && (state.searching || state.search[tab])) {
				state.searching = false;
				state.search[tab] = "";
				state.cursor[tab] = 0;
				return undefined;
			}
			return { kind: "close" };
		case "nextTab":
		case "prevTab": {
			const delta = key.kind === "nextTab" ? 1 : -1;
			state.tab = TABS[(TABS.indexOf(tab) + delta + TABS.length) % TABS.length];
			state.searching = false;
			clampPanelState(state, view);
			return undefined;
		}
		case "up":
			move(-1);
			return undefined;
		case "down":
			move(1);
			return undefined;
		case "pageUp":
			move(-10);
			return undefined;
		case "pageDown":
			move(10);
			return undefined;
		case "backspace":
			if (isRuleTab(tab) && state.searching) {
				state.search[tab] = state.search[tab].slice(0, -1);
				if (!state.search[tab]) state.searching = false;
				state.cursor[tab] = 0;
			}
			return undefined;
		case "enter": {
			if (tab === "recent") {
				const denial = view.denials[state.cursor.recent];
				// Un-approving a row also takes back its retry: a retry is an approval.
				if (denial && !toggle(state.approved, denial.id)) state.retry.delete(denial.id);
				return undefined;
			}
			const row = ruleListRows(state, view, tab)[state.cursor[tab]];
			state.searching = false;
			if (row?.kind === "add") state.dialog = { kind: "addRule", behavior: tab, draft: "" };
			else if (row?.kind === "rule") state.dialog = { kind: "ruleDetail", behavior: tab, key: row.rule.key, cursor: 0 };
			return undefined;
		}
		case "text": {
			if (tab === "recent") {
				const denial = view.denials[state.cursor.recent];
				if (denial && key.text.toLowerCase() === "r" && toggle(state.retry, denial.id)) state.approved.add(denial.id);
				return undefined;
			}
			if (state.searching) {
				state.search[tab] += key.text;
				state.cursor[tab] = 0;
				return undefined;
			}
			if (key.text === "j") move(1);
			else if (key.text === "k") move(-1);
			else if (key.text === "/") {
				state.searching = true;
				state.search[tab] = "";
			} else if (!NO_SEARCH_KEYS.has(key.text[0])) {
				state.searching = true;
				state.search[tab] = key.text;
				state.cursor[tab] = 0;
			}
			return undefined;
		}
	}
}
