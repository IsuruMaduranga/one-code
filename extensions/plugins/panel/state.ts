/**
 * /plugins panel state machine (pure).
 *
 * `applyPanelKey` mutates the state in place (the wiring owns the object and
 * repaints after every key) and returns an effect when the key demands I/O —
 * installs, toggles, marketplace operations — which the wiring executes
 * asynchronously and reflects back through the data it renders.
 *
 * Key routing: navigation keys are always controls. Printable text feeds the
 * search box in Discover (a browse tab: type to filter, Enter to read before
 * installing), the draft in the Add Marketplace dialog, and single-letter
 * actions in Marketplaces (`u` update, `d` remove) and the detail view
 * (`i`/`u`/`e`/`d`/`f`) — the views without a text field.
 *
 * The Installed tab follows the /skills panel instead: Enter and Space act on
 * the row in place (toggle a plugin or skill; open an MCP server's detail,
 * which has no toggle), search sits behind `/` (Esc leaves it), and the free
 * letters act directly — `v` view, `e`/`d` set, `u` uninstall, `f` favorite.
 */

import type { PanelKey } from "./keys.ts";
import type { DiscoverRow, InstalledRow, MarketplaceRow } from "./rows.ts";

export type Tab = "discover" | "installed" | "marketplaces" | "errors";
export const TABS: Tab[] = ["discover", "installed", "marketplaces", "errors"];

export type DetailRef =
	| { kind: "discover"; id: string }
	| { kind: "plugin"; id: string }
	| { kind: "skill"; overrideKey: string }
	| { kind: "mcp"; name: string };

export interface PanelState {
	tab: Tab;
	cursor: Record<Tab, number>;
	search: { discover: string; installed: string };
	/** Installed tab: `/` opened the search box, so typed text feeds it. */
	installedSearching: boolean;
	addDialog?: { draft: string };
	detail?: DetailRef;
	restartNeeded: boolean;
	notice?: string;
}

export interface PanelView {
	discover: DiscoverRow[];
	installed: InstalledRow[];
	marketplaces: MarketplaceRow[];
	errors: string[];
}

export type PanelEffect =
	| { kind: "close" }
	| { kind: "installToggle"; row: DiscoverRow }
	| { kind: "setPluginEnabled"; id: string; origin: "claude" | "one-code"; enabled: boolean }
	| { kind: "uninstall"; id: string }
	| { kind: "setSkillEnabled"; overrideKey: string; enabled: boolean }
	| { kind: "toggleFavorite"; target: "plugin" | "skill"; key: string }
	| { kind: "addMarketplace"; input: string }
	| { kind: "removeMarketplace"; name: string }
	| { kind: "refreshMarketplace"; name: string };

export function initialPanelState(): PanelState {
	return {
		tab: "discover",
		cursor: { discover: 0, installed: 0, marketplaces: 0, errors: 0 },
		search: { discover: "", installed: "" },
		installedSearching: false,
		restartNeeded: false,
	};
}

/** Rows the cursor can land on (Installed section headers are skipped). */
export function selectableRows(state: PanelState, view: PanelView): Array<DiscoverRow | InstalledRow | MarketplaceRow | string> {
	switch (state.tab) {
		case "discover":
			return view.discover;
		case "installed":
			return view.installed.filter((row) => row.kind !== "section");
		case "marketplaces":
			return view.marketplaces;
		case "errors":
			return view.errors;
	}
}

export function clampPanelState(state: PanelState, view: PanelView): void {
	const max = Math.max(0, selectableRows(state, view).length - 1);
	state.cursor[state.tab] = Math.min(Math.max(0, state.cursor[state.tab]), max);
}

function selected(state: PanelState, view: PanelView): DiscoverRow | InstalledRow | MarketplaceRow | string | undefined {
	return selectableRows(state, view)[state.cursor[state.tab]];
}

function detailFor(row: DiscoverRow | InstalledRow | MarketplaceRow | string, tab: Tab): DetailRef | undefined {
	if (typeof row === "string") return undefined;
	if (tab === "discover") return { kind: "discover", id: (row as DiscoverRow).id };
	if ("kind" in row) {
		if (row.kind === "plugin") return { kind: "plugin", id: row.id };
		if (row.kind === "skill") return { kind: "skill", overrideKey: row.overrideKey };
		if (row.kind === "mcp") return { kind: "mcp", name: row.name };
	}
	return undefined;
}

/** Resolve a detail ref against the CURRENT view (rows shift under async refreshes). */
export function resolveDetail(ref: DetailRef, view: PanelView): DiscoverRow | InstalledRow | undefined {
	switch (ref.kind) {
		case "discover":
			return view.discover.find((row) => row.id === ref.id);
		case "plugin":
			return view.installed.find((row) => row.kind === "plugin" && row.id === ref.id);
		case "skill":
			return view.installed.find((row) => row.kind === "skill" && row.overrideKey === ref.overrideKey);
		case "mcp":
			return view.installed.find((row) => row.kind === "mcp" && row.name === ref.name);
	}
}

function detailEffect(state: PanelState, view: PanelView, letter: string): PanelEffect | undefined {
	const ref = state.detail;
	if (!ref) return undefined;
	const row = resolveDetail(ref, view);
	if (!row || typeof row === "string") return undefined;

	if (ref.kind === "discover") {
		const discover = row as DiscoverRow;
		if (letter === "i" && !discover.installed) return { kind: "installToggle", row: discover };
		if (letter === "u" && discover.installed) return { kind: "installToggle", row: discover };
		return undefined;
	}
	return "kind" in row ? installedLetterEffect(row, letter) : undefined;
}

/** `e`/`d` set, `u` uninstall (One Code-installed only), `f` favorite — shared by the detail view and the Installed list. */
function installedLetterEffect(row: InstalledRow, letter: string): PanelEffect | undefined {
	if (row.kind === "plugin") {
		if (letter === "e") return { kind: "setPluginEnabled", id: row.id, origin: row.origin, enabled: true };
		if (letter === "d") return { kind: "setPluginEnabled", id: row.id, origin: row.origin, enabled: false };
		if (letter === "u" && row.origin === "one-code") return { kind: "uninstall", id: row.id };
		if (letter === "f") return { kind: "toggleFavorite", target: "plugin", key: row.id };
	}
	if (row.kind === "skill") {
		if (letter === "e") return { kind: "setSkillEnabled", overrideKey: row.overrideKey, enabled: true };
		if (letter === "d") return { kind: "setSkillEnabled", overrideKey: row.overrideKey, enabled: false };
		if (letter === "f") return { kind: "toggleFavorite", target: "skill", key: row.overrideKey };
	}
	return undefined;
}

/**
 * Installed tab, Enter or Space: toggle a plugin/skill row in place (the
 * /skills model); an MCP row has no toggle, so open its detail instead.
 */
function selectedInstalled(state: PanelState, view: PanelView): Exclude<InstalledRow, { kind: "section" }> | undefined {
	if (state.tab !== "installed") return undefined;
	return view.installed.filter((r) => r.kind !== "section")[state.cursor.installed];
}

function installedPrimary(state: PanelState, view: PanelView): PanelEffect | undefined {
	const row = selectedInstalled(state, view);
	if (!row) return undefined;
	if (row.kind === "plugin") return { kind: "setPluginEnabled", id: row.id, origin: row.origin, enabled: !row.enabled };
	if (row.kind === "skill") return { kind: "setSkillEnabled", overrideKey: row.overrideKey, enabled: !row.enabled };
	if (row.kind === "mcp") state.detail = { kind: "mcp", name: row.name };
	return undefined;
}

/** Installed tab, single letters outside search: `v` view, `e`/`d` set, `u` uninstall, `f` favorite. */
function installedLetter(state: PanelState, view: PanelView, letter: string): PanelEffect | undefined {
	const row = selectedInstalled(state, view);
	if (!row) return undefined;
	if (letter === "v") {
		state.detail = detailFor(row, "installed");
		return undefined;
	}
	return installedLetterEffect(row, letter);
}

export function applyPanelKey(state: PanelState, key: PanelKey, view: PanelView): PanelEffect | undefined {
	state.notice = undefined;

	// Modal Add Marketplace dialog captures everything.
	if (state.addDialog) {
		const dialog = state.addDialog;
		switch (key.kind) {
			case "text":
				dialog.draft += key.text;
				return undefined;
			case "backspace":
				dialog.draft = dialog.draft.slice(0, -1);
				return undefined;
			case "enter": {
				const input = dialog.draft.trim();
				state.addDialog = undefined;
				return input ? { kind: "addMarketplace", input } : undefined;
			}
			case "back":
			case "close":
				state.addDialog = undefined;
				return undefined;
			default:
				return undefined;
		}
	}

	if (state.detail) {
		switch (key.kind) {
			case "back":
				state.detail = undefined;
				return undefined;
			case "close":
				return { kind: "close" };
			case "enter":
			case "space": {
				const row = resolveDetail(state.detail, view);
				if (row && "kind" in row) {
					if (row.kind === "plugin") {
						return { kind: "setPluginEnabled", id: row.id, origin: row.origin, enabled: !row.enabled };
					}
					if (row.kind === "skill") {
						return { kind: "setSkillEnabled", overrideKey: row.overrideKey, enabled: !row.enabled };
					}
				}
				return undefined;
			}
			case "text":
				return key.text.length === 1 ? detailEffect(state, view, key.text.toLowerCase()) : undefined;
			default:
				return undefined;
		}
	}

	switch (key.kind) {
		case "close":
			return { kind: "close" };
		case "back": {
			if (state.tab === "discover" && state.search.discover) {
				state.search.discover = "";
				return undefined;
			}
			if (state.tab === "installed" && (state.installedSearching || state.search.installed)) {
				state.installedSearching = false;
				state.search.installed = "";
				return undefined;
			}
			return { kind: "close" };
		}
		case "nextTab":
		case "prevTab": {
			const delta = key.kind === "nextTab" ? 1 : -1;
			state.tab = TABS[(TABS.indexOf(state.tab) + delta + TABS.length) % TABS.length];
			return undefined;
		}
		case "up":
		case "down":
		case "pageUp":
		case "pageDown": {
			const step = key.kind === "up" ? -1 : key.kind === "down" ? 1 : key.kind === "pageUp" ? -10 : 10;
			state.cursor[state.tab] += step;
			clampPanelState(state, view);
			return undefined;
		}
		case "enter": {
			const row = selected(state, view);
			if (row === undefined) return undefined;
			if (state.tab === "marketplaces") {
				if (typeof row !== "string" && "kind" in row && row.kind === "add") {
					state.addDialog = { draft: "" };
					return undefined;
				}
				if (typeof row !== "string" && "kind" in row && row.kind === "marketplace") {
					state.notice = `${row.name} — ${row.sourceLine}${row.error ? ` — ${row.error}` : ""}`;
					return undefined;
				}
				return undefined;
			}
			if (state.tab === "installed") return installedPrimary(state, view);
			const ref = detailFor(row, state.tab);
			if (ref) state.detail = ref;
			return undefined;
		}
		case "space": {
			const row = selected(state, view);
			if (row === undefined || typeof row === "string") return undefined;
			if (state.tab === "discover") return { kind: "installToggle", row: row as DiscoverRow };
			if (state.tab === "installed") return installedPrimary(state, view);
			return undefined;
		}
		case "backspace": {
			if (state.tab === "discover") state.search.discover = state.search.discover.slice(0, -1);
			else if (state.tab === "installed" && state.installedSearching) {
				state.search.installed = state.search.installed.slice(0, -1);
			}
			return undefined;
		}
		case "text": {
			if (state.tab === "discover") {
				state.search.discover += key.text;
				state.cursor.discover = 0;
				return undefined;
			}
			if (state.tab === "installed") {
				if (state.installedSearching) {
					state.search.installed += key.text;
					state.cursor.installed = 0;
					return undefined;
				}
				if (key.text === "/") {
					state.installedSearching = true;
					return undefined;
				}
				return key.text.length === 1 ? installedLetter(state, view, key.text.toLowerCase()) : undefined;
			}
			if (state.tab === "marketplaces" && key.text.length === 1) {
				const letter = key.text.toLowerCase();
				const row = selected(state, view);
				if (letter === "a") {
					state.addDialog = { draft: "" };
					return undefined;
				}
				if (row && typeof row !== "string" && "kind" in row && row.kind === "marketplace") {
					if (letter === "u") return { kind: "refreshMarketplace", name: row.name };
					if (letter === "d") return { kind: "removeMarketplace", name: row.name };
				}
			}
			return undefined;
		}
		default:
			return undefined;
	}
}
