/**
 * plugins extension — Claude Code plugin support.
 *
 * Two jobs:
 *
 *  1. Wire installed plugins' slash commands in (agents/skills/MCP/LSP/hooks
 *     are consumed by their own extensions via discoverPlugins — module state
 *     is not shared between extension files, so each re-derives).
 *  2. The /plugins panel: a full-screen tabbed manager (Discover / Installed /
 *     Marketplaces / Errors) over the marketplace backend in ./marketplace and
 *     ./install. All layout/key logic is pure in ./panel; this file owns
 *     mutable state, async marketplace/install work, and repaints.
 *
 * Every write goes to the One Code plugin root (lib/plugin-root.ts) —
 * ~/.claude is read-only here, always.
 */

import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFavorites, toggleFavorite } from "../lib/favorites.ts";
import { MCP_STATUS_CHANNEL, MCP_STATUS_REQUEST_CHANNEL, type McpStatusEvent } from "../lib/mcp-status.ts";
import { setOverride } from "../lib/plugin-overrides.ts";
import { pathWithinBase, pluginRoot } from "../lib/plugin-root.ts";
import {
	defaultDiscoverRoots,
	type DiscoveredPlugins,
	discoverPlugins,
	findPluginSkills,
	invalidatePluginsCache,
	type Plugin,
	pluginResources,
} from "../lib/plugins.ts";
import { estimateSkillTokens, scanSkills } from "../lib/skill-scan.ts";
import { readSkillOverrides, setSkillOverride } from "../lib/skill-overrides.ts";
import { safeThemeBold, safeThemeInverse, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { readUsage, recordUsage } from "../lib/usage-tracker.ts";
import { fetchInstallCounts, readCachedCounts } from "./counts.ts";
import { installPlugin, uninstallPlugin } from "./install/install.ts";
import { setInstalledEnabled } from "./install/registry.ts";
import {
	ensureOfficialRegistered,
	isStale,
	OFFICIAL_MARKETPLACE_NAME,
	OFFICIAL_MARKETPLACE_SOURCE,
} from "./marketplace/official.ts";
import { parseMarketplaceInput } from "./marketplace/parse.ts";
import {
	availableMarketplaceName,
	readKnownMarketplaces,
	removeKnownMarketplace,
	writeKnownMarketplace,
} from "./marketplace/registry.ts";
import { installLocationFor, marketplaceCacheDir, type MarketplaceSnapshot, syncMarketplace } from "./marketplace/sync.ts";
import type { KnownMarketplace } from "./marketplace/types.ts";
import { decodePanelKey } from "./panel/keys.ts";
import { type DiscoverDetail, renderPanel, type PanelPaint } from "./panel/render.ts";
import { buildDiscoverRows, buildInstalledRows, buildMarketplaceRows, type DiscoverRow } from "./panel/rows.ts";
import { applyPanelKey, initialPanelState, type PanelEffect, type PanelView } from "./panel/state.ts";
import { findShellPlaceholders, replaceShellPlaceholders, substituteArguments } from "./template.ts";

const run = promisify(execFile);
const SHELL_TIMEOUT_MS = 30_000;

async function expandTemplate(body: string, args: string, cwd: string): Promise<string> {
	const withArgs = substituteArguments(body, args);
	const commands = [...new Set(findShellPlaceholders(withArgs))];
	if (commands.length === 0) return withArgs;

	const outputs = new Map<string, string>();
	await Promise.all(
		commands.map(async (command) => {
			try {
				const { stdout, stderr } = await run(command, {
					cwd,
					shell: true,
					timeout: SHELL_TIMEOUT_MS,
					maxBuffer: 2 * 1024 * 1024,
				});
				outputs.set(command, (stdout || stderr || "").trim());
			} catch (error) {
				const detail = error as { stdout?: string; stderr?: string; message?: string };
				outputs.set(command, (detail.stdout || detail.stderr || detail.message || "command failed").trim());
			}
		}),
	);
	return replaceShellPlaceholders(withArgs, outputs);
}

export default function pluginsExtension(pi: ExtensionAPI) {
	const registeredCommands = new Set<string>();
	let discovered = discoverPlugins(defaultDiscoverRoots(getAgentDir()));

	const registerCommands = (plugins: DiscoveredPlugins) => {
		for (const command of plugins.commands) {
			if (registeredCommands.has(command.name)) continue;
			const plugin = plugins.plugins.find((p) => p.name === command.plugin);
			if (!plugin) continue;
			registeredCommands.add(command.name);
			registerPluginCommand(pi, plugin, command.name, command.path);
		}
	};
	registerCommands(discovered);

	// Latest MCP snapshot; the panel triggers a request on open (the bus does
	// not replay, and this extension can't read the mcp extension's state).
	let mcpStatus: McpStatusEvent | undefined;
	let repaintPanel: (() => void) | undefined;
	pi.events.on(MCP_STATUS_CHANNEL, (event) => {
		mcpStatus = event as McpStatusEvent;
		repaintPanel?.();
	});

	let panelOpen = false;

	const openPanel = async (ctx: ExtensionContext): Promise<void> => {
		if (panelOpen) return;
		panelOpen = true;
		let restartNotice = false;
		try {
			await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
				const paint: PanelPaint = {
					fg: safeThemePaint(theme),
					bold: safeThemeBold(theme),
					inverse: safeThemeInverse(theme),
				};
				const roots = defaultDiscoverRoots(getAgentDir(), ctx.cwd);
				const oneCodeRoot = roots.oneCodeRoot;

				const state = initialPanelState();
				const snapshots = new Map<string, MarketplaceSnapshot>();
				const loading = new Set<string>();
				const actionErrors: string[] = [];
				const busy = new Set<string>();
				let counts = readCachedCounts(oneCodeRoot);
				let known: Record<string, KnownMarketplace> = {};

				// Two caches: rendered lines (per width, cleared on ANY repaint) and
				// the view model (fs scans — cleared only when data actually changed,
				// so a cursor move or ticker tick never re-reads the disk).
				let cache: { width: number; lines: string[] } | undefined;
				let viewCache: PanelView | undefined;
				const repaint = () => {
					cache = undefined;
					tui.requestRender();
				};
				/** Data changed (effect ran, async work landed, search edited). */
				const refresh = () => {
					viewCache = undefined;
					repaint();
				};
				repaintPanel = refresh;
				// The ticker only animates in-flight async work; every real state
				// change repaints explicitly.
				const ticker = setInterval(() => {
					if (loading.size > 0 || busy.size > 0) repaint();
				}, 500);
				ticker.unref?.();

				const rediscover = () => {
					invalidatePluginsCache();
					discovered = discoverPlugins(roots);
					registerCommands(discovered);
					viewCache = undefined;
				};

				const track = async <T>(label: string, work: Promise<T>): Promise<T | undefined> => {
					loading.add(label);
					repaint();
					try {
						return await work;
					} catch (error) {
						actionErrors.push(`${label} failed: ${(error as Error).message}`);
						return undefined;
					} finally {
						loading.delete(label);
						refresh();
					}
				};

				const syncOne = async (name: string, entry: KnownMarketplace, refreshContent: boolean) => {
					const snapshot = await track(
						`${refreshContent ? "updating" : "loading"} ${name}…`,
						syncMarketplace(oneCodeRoot, name, entry, { refresh: refreshContent }),
					);
					if (snapshot) {
						snapshots.set(name, snapshot);
						known = { ...known, [name]: snapshot.known };
					}
				};

				// Lazy startup work — on open only, never at session start: register
				// the official marketplace, sync every known one (refresh official
				// when stale), fetch install counts, ask mcp for a status snapshot.
				const openTasks = async () => {
					ensureOfficialRegistered(
						oneCodeRoot,
						installLocationFor(oneCodeRoot, OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_SOURCE),
					);
					known = readKnownMarketplaces(oneCodeRoot);
					// The counts fetch is independent of the marketplace syncs.
					await Promise.all([
						...Object.entries(known).map(([name, entry]) =>
							syncOne(name, entry, name === OFFICIAL_MARKETPLACE_NAME && isStale(entry)),
						),
						track("fetching install counts…", fetchInstallCounts(oneCodeRoot)).then((fetched) => {
							if (fetched) counts = fetched;
						}),
					]);
				};
				void openTasks();
				pi.events.emit(MCP_STATUS_REQUEST_CHANNEL, {});

				const buildView = (): PanelView => {
					const installedIds = new Set(discovered.plugins.map((p) => p.id));
					const usage = readUsage(oneCodeRoot);
					const favorites = readFavorites(oneCodeRoot);
					const skillOverrides = readSkillOverrides(oneCodeRoot);
					const pluginSkills = discovered.enabledPlugins.flatMap((plugin) => {
						const dir = pluginResources(plugin).skillsDir;
						return dir ? findPluginSkills(plugin, dir) : [];
					});
					const skills = scanSkills(ctx.cwd, roots.home, getAgentDir(), pluginSkills).map((skill) => ({
						...skill,
						tokens: estimateSkillTokens(skill.path),
					}));
					return {
						discover: buildDiscoverRows({
							snapshots: [...snapshots.values()],
							installedIds,
							counts,
							busy,
							search: state.search.discover,
						}),
						installed: buildInstalledRows({
							plugins: discovered.plugins,
							mcpServers: mcpStatus?.servers,
							skills,
							usage,
							skillOverrides,
							favorites,
							busy,
							search: state.search.installed,
						}),
						marketplaces: buildMarketplaceRows({ known, snapshots, installedIds }),
						errors: [...[...snapshots.values()].flatMap((s) => s.errors), ...actionErrors],
					};
				};

				const currentView = (): PanelView => (viewCache ??= buildView());

				const discoverDetails = (): Map<string, DiscoverDetail> => {
					const details = new Map<string, DiscoverDetail>();
					for (const snapshot of snapshots.values()) {
						if (!snapshot.manifest) continue;
						for (const entry of snapshot.manifest.plugins) {
							const contributions: string[] = [];
							const provides: Array<[string, string]> = [
								["commands", "commands"],
								["agents", "agents"],
								["skills", "skills"],
								["mcpServers", "MCP servers"],
								["lspServers", "LSP servers"],
								["hooks", "hooks"],
							];
							for (const [key, label] of provides) if (entry.raw[key] !== undefined) contributions.push(label);
							if (typeof entry.source === "string") contributions.push(`files: ${entry.source}`);
							details.set(`${entry.name}@${snapshot.name}`, {
								version: entry.version,
								author: entry.author?.name,
								category: entry.category,
								contributions,
							});
						}
					}
					return details;
				};

				const close = () => {
					clearInterval(ticker);
					repaintPanel = undefined;
					restartNotice = state.restartNeeded;
					done(null);
				};

				const installToggle = async (row: DiscoverRow) => {
					const plugin = discovered.plugins.find((p) => p.id === row.id);
					if (row.installed && plugin?.originRoot === "claude") {
						state.notice = `${row.name} was installed by Claude Code — uninstall it there (files are read-only here).`;
						return;
					}
					busy.add(row.id);
					refresh();
					try {
						if (row.installed) {
							uninstallPlugin(oneCodeRoot, row.id);
						} else {
							const snapshot = snapshots.get(row.marketplace);
							const entry = snapshot?.manifest?.plugins.find((p) => p.name === row.name);
							if (!snapshot || !entry) throw new Error(`${row.marketplace} has no entry named ${row.name}`);
							await installPlugin(oneCodeRoot, row.marketplace, entry, snapshot.contentRoot);
						}
						state.restartNeeded = true;
						rediscover();
					} catch (error) {
						actionErrors.push((error as Error).message);
						state.notice = (error as Error).message;
					} finally {
						busy.delete(row.id);
						refresh();
					}
				};

				const runEffect = (effect: PanelEffect) => {
					switch (effect.kind) {
						case "close":
							return close();
						case "installToggle":
							void installToggle(effect.row);
							return;
						case "setPluginEnabled": {
							if (effect.origin === "one-code") setInstalledEnabled(oneCodeRoot, effect.id, effect.enabled);
							else setOverride(oneCodeRoot, effect.id, effect.enabled);
							state.restartNeeded = true;
							rediscover();
							return;
						}
						case "uninstall": {
							uninstallPlugin(oneCodeRoot, effect.id);
							state.detail = undefined;
							state.restartNeeded = true;
							rediscover();
							return;
						}
						case "setSkillEnabled":
							setSkillOverride(oneCodeRoot, effect.overrideKey, effect.enabled);
							rediscover();
							return;
						case "toggleFavorite":
							toggleFavorite(oneCodeRoot, effect.target === "plugin" ? "plugin" : "skill", effect.key);
							return;
						case "addMarketplace": {
							const parsed = parseMarketplaceInput(effect.input, ctx.cwd);
							if ("error" in parsed) {
								state.notice = parsed.error;
								return;
							}
							const name = availableMarketplaceName(oneCodeRoot, parsed.suggestedName);
							const entry: KnownMarketplace = {
								source: parsed.source,
								installLocation: installLocationFor(oneCodeRoot, name, parsed.source),
								lastUpdated: new Date(0).toISOString(),
							};
							writeKnownMarketplace(oneCodeRoot, name, entry);
							known = { ...known, [name]: entry };
							void syncOne(name, entry, false);
							state.tab = "marketplaces";
							return;
						}
						case "removeMarketplace": {
							if (effect.name === OFFICIAL_MARKETPLACE_NAME) {
								state.notice = "The official marketplace re-registers on next open; remove individual plugins instead.";
							}
							removeKnownMarketplace(oneCodeRoot, effect.name);
							snapshots.delete(effect.name);
							// Cached content lives under OUR marketplaces dir only — a
							// file/directory source's user-owned path is never touched, and
							// a name that would escape the cache dir deletes nothing.
							const cacheBase = marketplaceCacheDir(oneCodeRoot);
							if (pathWithinBase(cacheBase, effect.name)) {
								rmSync(join(cacheBase, effect.name), { recursive: true, force: true });
								rmSync(join(cacheBase, `${effect.name}.json`), { force: true });
							}
							const { [effect.name]: _removed, ...rest } = known;
							known = rest;
							return;
						}
						case "refreshMarketplace": {
							const entry = known[effect.name];
							if (entry) void syncOne(effect.name, entry, true);
							return;
						}
					}
				};

				return {
					render: (width: number) => {
						if (cache?.width === width) return cache.lines;
						const height = Math.max(12, (tui as { terminal: { rows: number } }).terminal.rows - 2);
						const lines = renderPanel(
							{
								state,
								view: currentView(),
								width,
								height,
								loading: [...loading],
								discoverDetails: discoverDetails(),
								restartNeeded: state.restartNeeded,
							},
							paint,
						).map((line) => truncateLine(line, width));
						cache = { width, lines };
						return lines;
					},
					handleInput: (data: string) => {
						const key = decodePanelKey(data);
						if (!key) return;
						const effect = applyPanelKey(state, key, currentView());
						// Search edits change which rows exist; effects change the data
						// underneath. Pure navigation keeps the cached view.
						if (effect || key.kind === "text" || key.kind === "backspace" || key.kind === "back") {
							viewCache = undefined;
						}
						if (effect) runEffect(effect);
						repaint();
					},
					invalidate: () => {
						cache = undefined;
					},
					// Covers dismissal paths that aren't esc (session end, another
					// overlay) — without this the ticker outlives the component.
					dispose: () => {
						clearInterval(ticker);
						repaintPanel = undefined;
					},
				};
			});
		} finally {
			panelOpen = false;
		}
		if (restartNotice && ctx.hasUI) {
			ctx.ui.notify(
				"Plugin changes saved. Commands and the /plugins list update immediately; MCP servers, agents, and hooks apply on the next session restart.",
				"info",
			);
		}
	};

	pi.registerCommand("plugins", {
		description: "Browse, install, and manage Claude Code-compatible plugins and marketplaces",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				await openPanel(ctx);
				return;
			}
			// Non-interactive fallback: the old text listing.
			if (discovered.plugins.length === 0) {
				ctx.ui.notify("No plugins installed.", "info");
				return;
			}
			const lines = discovered.plugins.map((plugin) => {
				const summary = discovered.byPlugin.get(plugin.id);
				const parts: string[] = [];
				if (summary?.agents) parts.push("agents");
				if (summary?.skills) parts.push(`${summary.skills} skill${summary.skills === 1 ? "" : "s"}`);
				if (summary?.commands) parts.push(`${summary.commands} command${summary.commands === 1 ? "" : "s"}`);
				if (summary?.mcp) parts.push("mcp");
				if (summary?.lsp) parts.push("lsp");
				const state = plugin.enabled ? "" : " (disabled)";
				return `${plugin.name}${plugin.version && plugin.version !== "unknown" ? ` ${plugin.version}` : ""}${state} — ${parts.join(", ") || "nothing usable"}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function registerPluginCommand(pi: ExtensionAPI, plugin: Plugin, name: string, path: string): void {
	let description = `Command from the ${plugin.name} plugin`;
	let argumentHint: string | undefined;
	try {
		const { frontmatter } = parseFrontmatter(readFileSync(path, "utf-8")) as {
			frontmatter?: Record<string, unknown>;
		};
		if (typeof frontmatter?.description === "string") description = frontmatter.description;
		if (typeof frontmatter?.["argument-hint"] === "string") argumentHint = frontmatter["argument-hint"];
	} catch {
		// Fall back to the generic description.
	}

	pi.registerCommand(name, {
		description: argumentHint ? `${description} (${argumentHint})` : description,
		handler: async (args, ctx) => {
			let body: string;
			try {
				const parsed = parseFrontmatter(readFileSync(path, "utf-8")) as { body: string };
				body = parsed.body;
			} catch (error) {
				ctx.ui.notify(`Could not read ${path}: ${(error as Error).message}`, "error");
				return;
			}
			const expanded = await expandTemplate(body, args, ctx.cwd);
			recordUsage(pluginRoot(getAgentDir()), "command", name);
			// Deliver as a user turn, which is how Claude Code runs a command template.
			pi.sendUserMessage(expanded);
		},
	});
}
