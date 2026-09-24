/**
 * /permissions panel state machine (pure), Claude Code's panel (findings §33).
 *
 * `applyPanelKey` mutates the state in place (the wiring owns the object and
 * repaints after every key) and returns an effect when the key needs I/O:
 * saving or deleting a rule, editing the environment, or closing the panel,
 * at which point the wiring reads the approvals and retries off the state.
 *
 * Key routing, as in Claude Code:
 * - Recently denied: Enter toggles approval, `r` toggles retry (which also
 *   approves). Both act only when the panel closes.
 * - Allow / Ask / Deny / Auto mode: Enter opens the selected row (`Add a new
 *   rule…`, or a rule's detail). Typing any printable key except `j k m i r`
 *   and space starts a search with that key, `/` starts an empty one; `j`/`k`
 *   move the cursor. Backspace edits the search, Esc clears it.
 * - ←/→ and Tab switch tabs everywhere outside a dialog; Esc closes the panel.
 *
 * The Auto mode tab differs from Claude Code's in one way: the built-in rules
 * of a section are always in effect, so their row explains that instead of
 * offering to switch them off (working-docs/decisions/auto-mode.md).
 */

import type { PanelKey } from "./keys.ts";

export type Tab = "recent" | "allow" | "ask" | "deny" | "automode";
export const TABS: Tab[] = ["recent", "allow", "ask", "deny", "automode"];
export type RuleTab = "allow" | "ask" | "deny";
export const RULE_TABS: RuleTab[] = ["allow", "ask", "deny"];
/** Tabs with a search box. */
export type SearchTab = RuleTab | "automode";

export type AutoSection = "allow" | "soft_deny" | "hard_deny";
export const AUTO_SECTIONS: AutoSection[] = ["allow", "soft_deny", "hard_deny"];
/** Claude Code's names for the auto-mode sections. */
export const AUTO_SECTION_LABELS: Record<AutoSection, string> = { allow: "Soft allow", soft_deny: "Soft deny", hard_deny: "Hard deny" };

export interface DenialRow {
	id: number;
	display: string;
	/** The grounded rule name, shown dim after the call. */
	rule?: string;
}

/** Where an entry lives, and whether the panel may change it. */
interface Sourced {
	/** Unique within its list: the source file and the text. */
	key: string;
	/** `From One Code user settings (~/.onecode/settings.json)`. */
	sourceLabel: string;
	/** Only One Code's own files (and this session's grants) can be edited here. */
	editable: boolean;
	/** Why an uneditable entry cannot be changed here, and where to change it. */
	readOnlyNote?: string;
}

export interface RuleRow extends Sourced {
	behavior: RuleTab;
	raw: string;
}

export interface AutoEntryRow extends Sourced {
	section: AutoSection;
	text: string;
}

export interface AutoModeView {
	/** How many built-in rules each section holds. */
	builtins: Record<AutoSection, number>;
	/** The user's rules, in section order. */
	entries: AutoEntryRow[];
	environment: {
		/** The environment the classifier gets, first lines first. */
		lines: string[];
		/** `Built-in default`, or where the entries come from. */
		summary: string;
		/** True when the classifier gets only the built-in default. */
		isDefault: boolean;
	};
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
	autoMode: AutoModeView;
	/** Where a new permission rule can be saved, first one first. */
	destinations: Destination[];
	/** Why a typed permission rule cannot be saved, or undefined when it parses. */
	ruleError: (raw: string) => string | undefined;
}

export type Dialog =
	| { kind: "addRule"; behavior: RuleTab; draft: string }
	| { kind: "saveRule"; behavior: RuleTab; rule: string; cursor: number }
	| { kind: "ruleDetail"; behavior: RuleTab; key: string; cursor: number }
	| { kind: "pickSection"; cursor: number }
	/** A new rule, or an edit of `editKey`. */
	| { kind: "autoRuleInput"; section: AutoSection; draft: string; editKey?: string }
	/** Edit / Delete for an editable entry; an explanation for a read-only one. */
	| { kind: "autoRuleDetail"; key: string; cursor: number }
	| { kind: "autoRuleDelete"; key: string; cursor: number }
	| { kind: "builtinsInfo"; section: AutoSection }
	| { kind: "envConfirm"; cursor: number };

export interface PanelState {
	tab: Tab;
	cursor: Record<Tab, number>;
	search: Record<SearchTab, string>;
	/** A tab's search box has the keyboard (typed text feeds it). */
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
	| { kind: "deleteRule"; behavior: RuleTab; key: string }
	| { kind: "addAutoRule"; section: AutoSection; text: string }
	| { kind: "editAutoRule"; key: string; text: string }
	| { kind: "deleteAutoRule"; key: string }
	| { kind: "editEnvironment" };

export type RuleListRow = { kind: "add" } | { kind: "rule"; rule: RuleRow };
export type AutoListRow = { kind: "add" } | { kind: "builtins"; section: AutoSection } | { kind: "entry"; entry: AutoEntryRow } | { kind: "environment" };

export function initialPanelState(hasDenials: boolean): PanelState {
	return {
		// Claude Code opens on Recently denied when there is something to act on.
		tab: hasDenials ? "recent" : "allow",
		cursor: { recent: 0, allow: 0, ask: 0, deny: 0, automode: 0 },
		search: { allow: "", ask: "", deny: "", automode: "" },
		searching: false,
		approved: new Set(),
		retry: new Set(),
	};
}

export const isRuleTab = (tab: Tab): tab is RuleTab => (RULE_TABS as Tab[]).includes(tab);
const isSearchTab = (tab: Tab): tab is SearchTab => tab !== "recent";

/** A rule tab's rows: `Add a new rule…` (hidden while a query filters the list), then the matching rules. */
export function ruleListRows(state: PanelState, view: PanelView, tab: RuleTab): RuleListRow[] {
	const query = state.search[tab].toLowerCase();
	const rules = view.rules[tab].filter((rule) => !query || rule.raw.toLowerCase().includes(query)).map((rule) => ({ kind: "rule" as const, rule }));
	return query ? rules : [{ kind: "add" }, ...rules];
}

/**
 * The Auto mode tab's rows: `Add a new rule…`, then per section its built-in
 * row and the user's entries, then the environment. A query keeps only the
 * matching entries.
 */
export function autoListRows(state: PanelState, view: PanelView): AutoListRow[] {
	const query = state.search.automode.toLowerCase();
	const entries = view.autoMode.entries;
	if (query) return entries.filter((entry) => entry.text.toLowerCase().includes(query)).map((entry) => ({ kind: "entry", entry }));
	return [
		{ kind: "add" },
		...AUTO_SECTIONS.flatMap((section): AutoListRow[] => [
			{ kind: "builtins", section },
			...entries.filter((entry) => entry.section === section).map((entry): AutoListRow => ({ kind: "entry", entry })),
		]),
		{ kind: "environment" },
	];
}

function rowCount(state: PanelState, view: PanelView): number {
	if (state.tab === "recent") return view.denials.length;
	if (state.tab === "automode") return autoListRows(state, view).length;
	return ruleListRows(state, view, state.tab).length;
}

/** How many options a dialog's cursor moves over; 0 for a dialog without a choice list. */
function dialogOptions(dialog: Dialog, view: PanelView): number {
	switch (dialog.kind) {
		case "saveRule":
			return view.destinations.length;
		case "pickSection":
			return AUTO_SECTIONS.length;
		case "ruleDetail":
		case "autoRuleDetail":
		case "autoRuleDelete":
		case "envConfirm":
			return 2;
		default:
			return 0;
	}
}

export function clampPanelState(state: PanelState, view: PanelView): void {
	const max = Math.max(0, rowCount(state, view) - 1);
	state.cursor[state.tab] = Math.min(Math.max(0, state.cursor[state.tab]), max);
	const dialog = state.dialog;
	if (dialog && "cursor" in dialog) dialog.cursor = Math.min(Math.max(0, dialog.cursor), Math.max(0, dialogOptions(dialog, view) - 1));
}

/** The rule a detail dialog shows, resolved against the current view (it may have been reloaded). */
export function detailRule(dialog: Extract<Dialog, { kind: "ruleDetail" }>, view: PanelView): RuleRow | undefined {
	return view.rules[dialog.behavior].find((rule) => rule.key === dialog.key);
}

/** The auto-mode entry a dialog names, resolved against the current view. */
export function autoEntry(key: string, view: PanelView): AutoEntryRow | undefined {
	return view.autoMode.entries.find((entry) => entry.key === key);
}

const toggle = (set: Set<number>, id: number): boolean => {
	if (set.delete(id)) return false;
	set.add(id);
	return true;
};

/** Keys that do not start a search in Claude Code (vim navigation, reserved letters, space). */
const NO_SEARCH_KEYS = new Set(["j", "k", "m", "i", "r", " "]);

/** Move a dialog's cursor, wrapping; `y`/`n` pick the first or second of two options. */
function moveDialogCursor(dialog: Dialog & { cursor: number }, key: PanelKey, options: number): void {
	if (options === 0) return;
	if (key.kind === "up") dialog.cursor = (dialog.cursor - 1 + options) % options;
	else if (key.kind === "down") dialog.cursor = (dialog.cursor + 1) % options;
	else if (key.kind === "text" && options === 2 && /^[yn]$/i.test(key.text)) dialog.cursor = key.text.toLowerCase() === "y" ? 0 : 1;
}

/** Typing into a draft: text appends, backspace deletes. True when the key was a draft edit. */
function editDraft(dialog: { draft: string }, key: PanelKey): boolean {
	if (key.kind === "text") dialog.draft += key.text;
	else if (key.kind === "backspace") dialog.draft = dialog.draft.slice(0, -1);
	else return false;
	return true;
}

function applyDialogKey(state: PanelState, dialog: Dialog, key: PanelKey, view: PanelView): PanelEffect | undefined {
	if (key.kind === "close") return { kind: "close" };
	const shut = () => {
		state.dialog = undefined;
	};
	switch (dialog.kind) {
		case "addRule": {
			if (editDraft(dialog, key)) return undefined;
			if (key.kind === "back") shut();
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
			moveDialogCursor(dialog, key, view.destinations.length);
			if (key.kind === "back") state.dialog = { kind: "addRule", behavior: dialog.behavior, draft: dialog.rule };
			else if (key.kind === "enter") {
				const destination = view.destinations[dialog.cursor];
				shut();
				if (destination) return { kind: "addRule", behavior: dialog.behavior, rule: dialog.rule, destination: destination.id };
			}
			return undefined;
		}
		case "ruleDetail": {
			const rule = detailRule(dialog, view);
			if (!rule || key.kind === "back" || (!rule.editable && key.kind === "enter")) {
				shut();
				return undefined;
			}
			if (!rule.editable) return undefined;
			// Yes / No, as in Claude Code's delete confirmation.
			moveDialogCursor(dialog, key, 2);
			if (key.kind === "enter") {
				shut();
				if (dialog.cursor === 0) return { kind: "deleteRule", behavior: dialog.behavior, key: dialog.key };
			}
			return undefined;
		}
		case "pickSection": {
			moveDialogCursor(dialog, key, AUTO_SECTIONS.length);
			if (key.kind === "back") shut();
			else if (key.kind === "enter") state.dialog = { kind: "autoRuleInput", section: AUTO_SECTIONS[dialog.cursor], draft: "" };
			return undefined;
		}
		case "autoRuleInput": {
			if (editDraft(dialog, key)) return undefined;
			if (key.kind === "back") shut();
			else if (key.kind === "enter") {
				const text = dialog.draft.trim();
				if (!text) return undefined;
				if (text === "$defaults") {
					state.notice = '"$defaults" is not a rule: the built-in rules always apply.';
					return undefined;
				}
				shut();
				return dialog.editKey ? { kind: "editAutoRule", key: dialog.editKey, text } : { kind: "addAutoRule", section: dialog.section, text };
			}
			return undefined;
		}
		case "autoRuleDetail": {
			const entry = autoEntry(dialog.key, view);
			if (!entry || key.kind === "back" || (!entry.editable && key.kind === "enter")) {
				shut();
				return undefined;
			}
			if (!entry.editable) return undefined;
			// Edit / Delete.
			moveDialogCursor(dialog, key, 2);
			if (key.kind === "text" && /^[ed]$/i.test(key.text)) dialog.cursor = key.text.toLowerCase() === "e" ? 0 : 1;
			if (key.kind === "enter") {
				state.dialog =
					dialog.cursor === 0
						? { kind: "autoRuleInput", section: entry.section, draft: entry.text, editKey: entry.key }
						: { kind: "autoRuleDelete", key: entry.key, cursor: 1 };
			}
			return undefined;
		}
		case "autoRuleDelete": {
			if (key.kind === "back") {
				shut();
				return undefined;
			}
			moveDialogCursor(dialog, key, 2);
			if (key.kind === "enter") {
				shut();
				if (dialog.cursor === 0) return { kind: "deleteAutoRule", key: dialog.key };
			}
			return undefined;
		}
		case "builtinsInfo": {
			if (key.kind === "back" || key.kind === "enter") shut();
			return undefined;
		}
		case "envConfirm": {
			if (key.kind === "back") {
				shut();
				return undefined;
			}
			moveDialogCursor(dialog, key, 2);
			if (key.kind === "enter") {
				shut();
				if (dialog.cursor === 0) return { kind: "editEnvironment" };
			}
			return undefined;
		}
	}
}

/** Enter on the Auto mode tab's selected row. */
function openAutoRow(state: PanelState, view: PanelView): PanelEffect | undefined {
	const row = autoListRows(state, view)[state.cursor.automode];
	state.searching = false;
	if (!row) return undefined;
	switch (row.kind) {
		case "add":
			state.dialog = { kind: "pickSection", cursor: 0 };
			return undefined;
		case "builtins":
			state.dialog = { kind: "builtinsInfo", section: row.section };
			return undefined;
		case "entry":
			state.dialog = { kind: "autoRuleDetail", key: row.entry.key, cursor: 0 };
			return undefined;
		case "environment":
			// Replacing the built-in default is confirmed first, as in Claude Code.
			if (view.autoMode.environment.isDefault) {
				state.dialog = { kind: "envConfirm", cursor: 0 };
				return undefined;
			}
			return { kind: "editEnvironment" };
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
			if (isSearchTab(tab) && (state.searching || state.search[tab])) {
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
			if (isSearchTab(tab) && state.searching) {
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
			if (tab === "automode") return openAutoRow(state, view);
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
