import { describe, expect, it } from "vitest";
import { decodePanelKey } from "../../extensions/plugins/panel/keys.ts";
import { renderPanel, type PanelPaint } from "../../extensions/plugins/panel/render.ts";
import {
	buildDiscoverRows,
	buildInstalledRows,
	type DiscoverRow,
	type InstalledRow,
} from "../../extensions/plugins/panel/rows.ts";
import {
	applyPanelKey,
	initialPanelState,
	type PanelState,
	type PanelView,
} from "../../extensions/plugins/panel/state.ts";
import type { MarketplaceSnapshot } from "../../extensions/plugins/marketplace/sync.ts";
import type { Plugin } from "../../extensions/lib/plugins.ts";

const paint: PanelPaint = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => `[${text}]`,
};

const snapshot = (name: string, plugins: Array<{ name: string; description?: string }>): MarketplaceSnapshot => ({
	name,
	known: { source: { source: "github", repo: `o/${name}` }, installLocation: `/mp/${name}`, lastUpdated: "2026-08-19T00:00:00Z" },
	manifest: { name, plugins: plugins.map((p) => ({ ...p, source: `./plugins/${p.name}`, raw: {} })) },
	errors: [],
	contentRoot: `/mp/${name}`,
});

const plugin = (overrides: Partial<Plugin> & { id: string; name: string }): Plugin => ({
	path: "/x",
	originRoot: "one-code",
	enabled: true,
	dataRoot: "/data",
	...overrides,
});

const emptyFavorites = { plugins: [], skills: [] };

const makeView = (over?: Partial<PanelView>): PanelView => ({
	discover: [],
	installed: [],
	marketplaces: [],
	errors: [],
	...over,
});

describe("decodePanelKey", () => {
	it("decodes navigation, swallows unknown escapes, passes printables", () => {
		expect(decodePanelKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodePanelKey("\x1b[Z")).toEqual({ kind: "prevTab" });
		expect(decodePanelKey("\t")).toEqual({ kind: "nextTab" });
		expect(decodePanelKey(" ")).toEqual({ kind: "space" });
		expect(decodePanelKey("\r")).toEqual({ kind: "enter" });
		expect(decodePanelKey("\x1b")).toEqual({ kind: "back" });
		expect(decodePanelKey("\x7f")).toEqual({ kind: "backspace" });
		expect(decodePanelKey("\x1b[15~")).toBeUndefined(); // F5 — never leaks into search
		expect(decodePanelKey("abc")).toEqual({ kind: "text", text: "abc" });
	});
});

describe("discover rows", () => {
	it("filters by search, sorts by installs, and marks installed", () => {
		const rows = buildDiscoverRows({
			snapshots: [snapshot("mp", [{ name: "alpha" }, { name: "beta", description: "does beta things" }])],
			installedIds: new Set(["alpha@mp"]),
			counts: new Map([["beta@mp", 1_200_000]]),
			busy: new Set(),
			search: "",
		});
		expect(rows.map((r) => r.name)).toEqual(["beta", "alpha"]); // installs first
		expect(rows[1]).toMatchObject({ installed: true });

		const filtered = buildDiscoverRows({
			snapshots: [snapshot("mp", [{ name: "alpha" }, { name: "beta", description: "does beta things" }])],
			installedIds: new Set(),
			busy: new Set(),
			search: "beta thing", // matches description
		});
		expect(filtered.map((r) => r.name)).toEqual(["beta"]);
	});
});

describe("installed rows grouping", () => {
	const baseInput = {
		usage: {},
		skillOverrides: {},
		favorites: emptyFavorites,
		busy: new Set<string>(),
		search: "",
		now: new Date("2026-08-19T00:00:00Z"),
	};

	it("groups favorites, attention, stale, active, mcp, skills in priority order", () => {
		const rows = buildInstalledRows({
			...baseInput,
			plugins: [
				plugin({ id: "fav@mp", name: "fav" }),
				plugin({ id: "used@mp", name: "used" }),
				plugin({ id: "stale@mp", name: "stale" }),
			],
			favorites: { plugins: ["fav@mp"], skills: [] },
			usage: { "command:used:go": { count: 3, lastUsedAt: "2026-08-18T00:00:00Z" } },
			mcpServers: [
				{ name: "good", status: "connected", toolCount: 4 },
				{ name: "bad", status: "failed", detail: "boom" },
			],
			skills: [{ name: "helper", path: "/s/SKILL.md", scope: "user", tokens: 120 }],
		});
		const titles = rows.filter((r) => r.kind === "section").map((r) => (r as { title: string }).title);
		expect(titles).toEqual(["Favorites", "Needs attention", "Not used recently", "Plugins", "MCP servers", "Skills"]);
		const inSection = (title: string) => {
			const start = rows.findIndex((r) => r.kind === "section" && (r as { title: string }).title === title);
			const next = rows.findIndex((r, i) => i > start && r.kind === "section");
			return rows.slice(start + 1, next === -1 ? undefined : next);
		};
		expect(inSection("Favorites")[0]).toMatchObject({ kind: "plugin", id: "fav@mp" });
		expect(inSection("Needs attention")[0]).toMatchObject({ kind: "mcp", name: "bad" });
		expect(inSection("Not used recently")[0]).toMatchObject({ kind: "plugin", id: "stale@mp" });
		expect(inSection("Plugins")[0]).toMatchObject({ kind: "plugin", id: "used@mp" });
		expect(inSection("Skills")[0]).toMatchObject({ kind: "skill", name: "helper", recency: "never used" });
	});

	it("skill rows resolve enabled state from overrides", () => {
		// The Installed tab only ever sees plugin-scope skills now (project/user
		// skills live in /skills); the builder itself stays scope-agnostic.
		const rows = buildInstalledRows({
			...baseInput,
			plugins: [],
			skills: [{ name: "demo:helper", path: "/s/SKILL.md", scope: "plugin", tokens: 10 }],
			skillOverrides: { "plugin:demo:helper": "off" },
		});
		expect(rows.find((r) => r.kind === "skill")).toMatchObject({ enabled: false, overrideKey: "plugin:demo:helper" });
	});
});

describe("panel state machine", () => {
	const discoverRow: DiscoverRow = {
		id: "beta@mp",
		name: "beta",
		marketplace: "mp",
		installed: false,
		busy: false,
	};
	const pluginRow: InstalledRow = {
		kind: "plugin",
		id: "p@mp",
		name: "p",
		enabled: true,
		origin: "claude",
		overridden: false,
		favorite: false,
		busy: false,
	};

	it("typing feeds search in discover; space toggles install", () => {
		const state = initialPanelState();
		const view = makeView({ discover: [discoverRow] });
		applyPanelKey(state, { kind: "text", text: "be" }, view);
		expect(state.search.discover).toBe("be");
		const effect = applyPanelKey(state, { kind: "space" }, view);
		expect(effect).toEqual({ kind: "installToggle", row: discoverRow });
	});

	it("esc clears a non-empty search before closing", () => {
		const state = initialPanelState();
		const view = makeView();
		state.search.discover = "x";
		expect(applyPanelKey(state, { kind: "back" }, view)).toBeUndefined();
		expect(state.search.discover).toBe("");
		expect(applyPanelKey(state, { kind: "back" }, view)).toEqual({ kind: "close" });
	});

	it("tab cycling and cursor clamping", () => {
		const state = initialPanelState();
		const view = makeView({ discover: [discoverRow] });
		applyPanelKey(state, { kind: "nextTab" }, view);
		expect(state.tab).toBe("installed");
		applyPanelKey(state, { kind: "prevTab" }, view);
		expect(state.tab).toBe("discover");
		applyPanelKey(state, { kind: "down" }, view);
		applyPanelKey(state, { kind: "down" }, view);
		expect(state.cursor.discover).toBe(0); // clamped to the single row
	});

	it("installed space toggles plugin enabled with origin routing info", () => {
		const state = initialPanelState();
		state.tab = "installed";
		const view = makeView({ installed: [{ kind: "section", title: "Plugins" }, pluginRow] });
		const effect = applyPanelKey(state, { kind: "space" }, view);
		expect(effect).toEqual({ kind: "setPluginEnabled", id: "p@mp", origin: "claude", enabled: false });
	});

	it("marketplaces: enter on Add opens the dialog; the dialog captures text and submits", () => {
		const state = initialPanelState();
		state.tab = "marketplaces";
		const view = makeView({ marketplaces: [{ kind: "add" }] });
		applyPanelKey(state, { kind: "enter" }, view);
		expect(state.addDialog).toEqual({ draft: "" });
		applyPanelKey(state, { kind: "text", text: "owner/repo" }, view);
		applyPanelKey(state, { kind: "backspace" }, view);
		expect(state.addDialog?.draft).toBe("owner/rep");
		const effect = applyPanelKey(state, { kind: "enter" }, view);
		expect(effect).toEqual({ kind: "addMarketplace", input: "owner/rep" });
		expect(state.addDialog).toBeUndefined();
	});

	it("marketplaces: u refreshes and d removes the selected marketplace", () => {
		const state = initialPanelState();
		state.tab = "marketplaces";
		const view = makeView({
			marketplaces: [
				{ kind: "add" },
				{ kind: "marketplace", name: "mp", sourceLine: "o/mp", installedCount: 0, updated: "2026-08-19", official: false },
			],
		});
		state.cursor.marketplaces = 1;
		expect(applyPanelKey(state, { kind: "text", text: "u" }, view)).toEqual({ kind: "refreshMarketplace", name: "mp" });
		expect(applyPanelKey(state, { kind: "text", text: "d" }, view)).toEqual({ kind: "removeMarketplace", name: "mp" });
	});

	it("detail: enter opens, letters act, esc goes back", () => {
		const state = initialPanelState();
		const view = makeView({ discover: [discoverRow] });
		applyPanelKey(state, { kind: "enter" }, view);
		expect(state.detail).toEqual({ kind: "discover", id: "beta@mp" });
		expect(applyPanelKey(state, { kind: "text", text: "i" }, view)).toEqual({ kind: "installToggle", row: discoverRow });
		applyPanelKey(state, { kind: "back" }, view);
		expect(state.detail).toBeUndefined();
	});
});

describe("renderPanel", () => {
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

	const renderInput = (state: PanelState, view: PanelView) => ({
		state,
		view,
		width: 80,
		height: 24,
		loading: [],
		discoverDetails: new Map(),
		restartNeeded: false,
	});

	it("renders the discover tab with counter, search, rows, and footer within width", () => {
		const state = initialPanelState();
		const view = makeView({
			discover: [
				{ id: "beta@mp", name: "beta", marketplace: "mp", installed: false, busy: false, installs: 1_200_000, description: "desc" },
			],
		});
		const lines = renderPanel(renderInput(state, view), paint).map(strip);
		expect(lines.some((l) => l.includes("Discover plugins (1/1)"))).toBe(true);
		expect(lines.some((l) => l.includes("⌕ Search…"))).toBe(true);
		expect(lines.some((l) => l.includes("○ beta · mp · 1.2M installs"))).toBe(true);
		expect(lines.some((l) => l.includes("Type to search"))).toBe(true);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(320);
	});

	it("renders the marketplaces tab with Add row and counts", () => {
		const state = initialPanelState();
		state.tab = "marketplaces";
		const view = makeView({
			marketplaces: [
				{ kind: "add" },
				{
					kind: "marketplace",
					name: "claude-plugins-official",
					sourceLine: "anthropics/claude-plugins-official",
					available: 286,
					installedCount: 8,
					updated: "2026-08-19T10:00:00Z",
					official: true,
				},
			],
		});
		const lines = renderPanel(renderInput(state, view), paint).map(strip);
		expect(lines.some((l) => l.includes("+ Add Marketplace"))).toBe(true);
		expect(lines.some((l) => l.includes("286 available • 8 installed • Updated 2026-08-19"))).toBe(true);
	});

	it("renders the empty errors tab and the add dialog", () => {
		const state = initialPanelState();
		state.tab = "errors";
		expect(renderPanel(renderInput(state, makeView()), paint).map(strip).some((l) => l.includes("No plugin errors"))).toBe(
			true,
		);

		state.addDialog = { draft: "owner/repo" };
		const dialog = renderPanel(renderInput(state, makeView()), paint).map(strip);
		expect(dialog.some((l) => l.includes("Add Marketplace"))).toBe(true);
		expect(dialog.some((l) => l.includes("owner/repo"))).toBe(true);
		expect(dialog.some((l) => l.includes("Enter to add · Esc to cancel"))).toBe(true);
	});

	it("renders a plugin detail with the trust note", () => {
		const state = initialPanelState();
		state.tab = "installed";
		state.detail = { kind: "plugin", id: "p@mp" };
		const view = makeView({
			installed: [
				{ kind: "plugin", id: "p@mp", name: "p", marketplace: "mp", enabled: true, origin: "claude", overridden: true, favorite: false, busy: false },
			],
		});
		const lines = renderPanel(renderInput(state, view), paint).map(strip);
		expect(lines.some((l) => l.includes("installed by Claude Code"))).toBe(true);
		expect(lines.some((l) => l.includes("One Code override"))).toBe(true);
		expect(lines.some((l) => l.includes("Make sure you trust a plugin"))).toBe(true);
	});
});
