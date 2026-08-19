/**
 * Row models for the /plugins panel tabs (pure).
 *
 * The Installed tab's grouping is One Code's own heuristic (Claude Code's
 * usage-recency data doesn't exist here): Favorites float first, then
 * "Needs attention" (MCP servers that failed or need auth), then plugins split
 * into "Not used recently" (no recorded command/skill use in 30 days,
 * including never) and "Plugins", then healthy "MCP servers", then "Skills".
 */

import type { McpServerStatus } from "../../lib/mcp-status.ts";
import type { Plugin } from "../../lib/plugins.ts";
import type { ScannedSkill } from "../../lib/skill-scan.ts";
import { isSkillEnabled, skillOverrideKey } from "../../lib/skill-overrides.ts";
import { formatRecency, type UsageEntry, usageKey } from "../../lib/usage-tracker.ts";
import type { Favorites } from "../../lib/favorites.ts";
import type { MarketplaceSnapshot } from "../marketplace/sync.ts";
import type { KnownMarketplace } from "../marketplace/types.ts";
import { OFFICIAL_MARKETPLACE_NAME } from "../marketplace/official.ts";

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export interface DiscoverRow {
	/** `name@marketplace`. */
	id: string;
	name: string;
	marketplace: string;
	description?: string;
	installs?: number;
	installed: boolean;
	busy: boolean;
}

export function buildDiscoverRows(input: {
	snapshots: MarketplaceSnapshot[];
	installedIds: Set<string>;
	counts?: Map<string, number>;
	busy: Set<string>;
	search: string;
}): DiscoverRow[] {
	const query = input.search.trim().toLowerCase();
	const rows: DiscoverRow[] = [];
	for (const snapshot of input.snapshots) {
		if (!snapshot.manifest) continue;
		for (const entry of snapshot.manifest.plugins) {
			const id = `${entry.name}@${snapshot.name}`;
			if (query && !entry.name.toLowerCase().includes(query) && !(entry.description ?? "").toLowerCase().includes(query)) {
				continue;
			}
			rows.push({
				id,
				name: entry.name,
				marketplace: snapshot.name,
				description: entry.description,
				installs: input.counts?.get(id),
				installed: input.installedIds.has(id),
				busy: input.busy.has(id),
			});
		}
	}
	rows.sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1) || a.name.localeCompare(b.name));
	return rows;
}

export type InstalledRow =
	| { kind: "section"; title: string }
	| {
			kind: "plugin";
			id: string;
			name: string;
			marketplace?: string;
			enabled: boolean;
			origin: Plugin["originRoot"];
			overridden: boolean;
			favorite: boolean;
			busy: boolean;
	  }
	| { kind: "mcp"; name: string; status: McpServerStatus["status"]; detail?: string; toolCount?: number; source?: string }
	| {
			kind: "skill";
			overrideKey: string;
			name: string;
			scope: ScannedSkill["scope"];
			tokens: number;
			recency: string;
			enabled: boolean;
			favorite: boolean;
	  };

/** Latest use across a plugin's namespaced commands/skills (`<plugin>:<name>` keys). */
function pluginLastUsed(plugin: Plugin, usage: Record<string, UsageEntry>): number | undefined {
	let latest: number | undefined;
	for (const [key, entry] of Object.entries(usage)) {
		const [, name] = key.split(/:(.+)/);
		if (!name?.startsWith(`${plugin.name}:`)) continue;
		const at = Date.parse(entry.lastUsedAt);
		if (!Number.isNaN(at) && (latest === undefined || at > latest)) latest = at;
	}
	return latest;
}

export function buildInstalledRows(input: {
	plugins: Plugin[];
	mcpServers?: McpServerStatus[];
	skills: Array<ScannedSkill & { tokens: number }>;
	usage: Record<string, UsageEntry>;
	skillOverrides: Record<string, boolean>;
	favorites: Favorites;
	busy: Set<string>;
	search: string;
	now?: Date;
}): InstalledRow[] {
	const query = input.search.trim().toLowerCase();
	const matches = (name: string) => !query || name.toLowerCase().includes(query);
	const now = (input.now ?? new Date()).getTime();

	const pluginRow = (plugin: Plugin): Extract<InstalledRow, { kind: "plugin" }> => ({
		kind: "plugin",
		id: plugin.id,
		name: plugin.name,
		marketplace: plugin.marketplace,
		enabled: plugin.enabled,
		origin: plugin.originRoot,
		overridden: plugin.overridden ?? false,
		favorite: input.favorites.plugins.includes(plugin.id),
		busy: input.busy.has(plugin.id),
	});

	const skillRow = (skill: ScannedSkill & { tokens: number }): Extract<InstalledRow, { kind: "skill" }> => {
		const key = skillOverrideKey(skill.scope, skill.name);
		return {
			kind: "skill",
			overrideKey: key,
			name: skill.name,
			scope: skill.scope,
			tokens: skill.tokens,
			recency: formatRecency(input.usage[usageKey("skill", skill.name)], input.now),
			enabled: isSkillEnabled(input.skillOverrides, key),
			favorite: input.favorites.skills.includes(key),
		};
	};

	const mcpRow = (server: McpServerStatus): Extract<InstalledRow, { kind: "mcp" }> => ({
		kind: "mcp",
		name: server.name,
		status: server.status,
		detail: server.detail,
		toolCount: server.toolCount,
		source: server.source,
	});

	const plugins = input.plugins.filter((p) => matches(p.name));
	const skills = input.skills.filter((s) => matches(s.name)).map(skillRow);
	const mcp = (input.mcpServers ?? []).filter((s) => matches(s.name));

	const favoritePluginRows = plugins.filter((p) => input.favorites.plugins.includes(p.id)).map(pluginRow);
	const favoriteSkillRows = skills.filter((s) => s.favorite);
	const attention = mcp.filter((s) => s.status === "failed" || s.status === "authNeeded").map(mcpRow);
	const rest = plugins.filter((p) => !input.favorites.plugins.includes(p.id));
	const stale = rest.filter((p) => {
		const last = pluginLastUsed(p, input.usage);
		return last === undefined || now - last > RECENT_MS;
	});
	const active = rest.filter((p) => !stale.includes(p));
	const healthyMcp = mcp.filter((s) => s.status === "connected" || s.status === "connecting").map(mcpRow);
	const normalSkills = skills.filter((s) => !s.favorite);

	const rows: InstalledRow[] = [];
	const section = (title: string, content: InstalledRow[]) => {
		if (content.length > 0) rows.push({ kind: "section", title }, ...content);
	};
	section("Favorites", [...favoritePluginRows, ...favoriteSkillRows]);
	section("Needs attention", attention);
	section("Not used recently", stale.map(pluginRow));
	section("Plugins", active.map(pluginRow));
	section("MCP servers", healthyMcp);
	section("Skills", normalSkills);
	return rows;
}

export type MarketplaceRow =
	| { kind: "add" }
	| {
			kind: "marketplace";
			name: string;
			sourceLine: string;
			available?: number;
			installedCount: number;
			updated: string;
			official: boolean;
			error?: string;
	  };

function sourceLine(known: KnownMarketplace): string {
	const { source } = known;
	switch (source.source) {
		case "github":
			return source.repo;
		case "git":
			return source.url;
		case "url":
			return source.url;
		case "file":
		case "directory":
			return source.path;
	}
}

export function buildMarketplaceRows(input: {
	known: Record<string, KnownMarketplace>;
	snapshots: Map<string, MarketplaceSnapshot>;
	installedIds: Set<string>;
}): MarketplaceRow[] {
	const rows: MarketplaceRow[] = [{ kind: "add" }];
	for (const [name, known] of Object.entries(input.known).sort(([a], [b]) => a.localeCompare(b))) {
		const snapshot = input.snapshots.get(name);
		const installedCount = [...input.installedIds].filter((id) => id.endsWith(`@${name}`)).length;
		rows.push({
			kind: "marketplace",
			name,
			sourceLine: sourceLine(known),
			available: snapshot?.manifest?.plugins.length,
			installedCount,
			updated: known.lastUpdated,
			official: name === OFFICIAL_MARKETPLACE_NAME,
			error: snapshot?.errors[0],
		});
	}
	return rows;
}
