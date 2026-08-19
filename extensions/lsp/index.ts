/**
 * lsp extension — language-server diagnostics, the way Claude Code surfaces them.
 *
 * Three behaviors:
 *  1. A session-wide watcher (watcher.ts): new diagnostics — cross-file, all
 *     severities, deduplicated against what was already delivered — are
 *     injected as a `<new-diagnostics>` message after the current tool round
 *     (deliverAs "steer"), or at the start of the next run when they arrived
 *     while idle. Editing a file clears its delivered-set so fixed-then-
 *     reintroduced issues resurface.
 *  2. Plugin-provided servers (plugin-servers.ts): an enabled plugin's
 *     `.lsp.json` / manifest `lspServers` adds servers routed by file
 *     extension, taking precedence over the built-in table — installing the
 *     plugin is explicit intent. Built-in servers keep root-marker detection;
 *     plugin servers root at `workspaceFolder ?? cwd`.
 *  3. An `lsp_diagnostics` tool (deferred behind `tool_search`) for asking
 *     about a file on demand.
 *
 * Claude Code has no other LSP tools; navigation goes through grep/find.
 */

import { mkdirSync } from "node:fs";
import { extname, relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { defaultDiscoverRoots, discoverPlugins, pluginResources } from "../lib/plugins.ts";
import { ccToolRenderers, customMessageText, notificationComponent } from "../lib/tui-render.ts";
import { LspClient, type LspClientOptions, pathToUri } from "./client.ts";
import { filterDiagnostics, formatDiagnostics, type LspDiagnostic, type SeverityFilter } from "./format.ts";
import {
	pluginLanguageId,
	readManifestLspServers,
	type ResolvedPluginServer,
	resolveExtensionRouting,
	resolvePluginServers,
} from "./plugin-servers.ts";
import { findProjectRoot, serverForPath, typescriptPreflight } from "./servers.ts";
import { computeDelta, DeliveredTracker, fingerprintDiagnostic, formatNewDiagnostics, markDelivered } from "./watcher.ts";

const NEW_DIAGNOSTICS_TYPE = "lsp-new-diagnostics";

/** Everything needed to spawn/reuse the server responsible for a path. */
interface ResolvedTarget {
	key: string;
	root: string;
	languageId: string;
	command: string;
	args: string[];
	options: LspClientOptions;
	/** Set when a plugin config (not the built-in table) claimed the extension. */
	plugin?: ResolvedPluginServer;
}

interface PluginRouting {
	byExtension: Map<string, ResolvedPluginServer>;
	collisions: string[];
	diagnostics: string[];
}

export default function lspExtension(pi: ExtensionAPI) {
	const clients = new Map<string, LspClient>();
	const startFailures = new Map<string, string>();
	const warned = new Set<string>();
	const tracker = new DeliveredTracker();

	// Built lazily on the first file touched — never at session_start
	// (findings §15: serial session_start work delays the prompt).
	let routing: PluginRouting | undefined;
	const pluginRouting = (cwd: string): PluginRouting => (routing ??= buildPluginRouting(cwd));

	function buildPluginRouting(cwd: string): PluginRouting {
		const discovered = discoverPlugins(defaultDiscoverRoots(getAgentDir(), cwd));
		const diagnostics: string[] = [];
		const servers: ResolvedPluginServer[] = [];
		for (const plugin of discovered.enabledPlugins) {
			const { lspConfig } = pluginResources(plugin);
			const manifestServers = readManifestLspServers(plugin.path);
			if (!lspConfig && manifestServers === undefined) continue;
			const resolved = resolvePluginServers(
				{ name: plugin.name, path: plugin.path, dataRoot: plugin.dataRoot },
				lspConfig,
				manifestServers,
				process.env,
			);
			servers.push(...resolved.servers);
			diagnostics.push(...resolved.diagnostics);
		}
		const routed = resolveExtensionRouting(servers);
		return { byExtension: routed.byExtension, collisions: routed.collisions, diagnostics };
	}

	const resolveTarget = (path: string, cwd: string): ResolvedTarget | undefined => {
		const pluginServer = pluginRouting(cwd).byExtension.get(extname(path).toLowerCase());
		if (pluginServer) {
			return {
				key: pluginServer.key,
				root: pluginServer.workspaceFolder ?? cwd,
				languageId: pluginLanguageId(pluginServer, path),
				command: pluginServer.command,
				args: pluginServer.args,
				options: {
					env: pluginServer.env,
					initializationOptions: pluginServer.initializationOptions,
					settings: pluginServer.settings,
					startupTimeoutMs: pluginServer.startupTimeoutMs,
				},
				plugin: pluginServer,
			};
		}
		const match = serverForPath(path);
		if (!match) return undefined;
		const root = findProjectRoot(path, match.config.rootMarkers, cwd);
		return {
			key: `${match.languageId}:${root}`,
			root,
			languageId: match.languageId,
			command: match.config.command,
			args: match.config.args,
			options: {},
		};
	};

	const clientFor = async (target: ResolvedTarget): Promise<LspClient | undefined> => {
		const { key } = target;
		if (startFailures.has(key)) return undefined;

		const existing = clients.get(key);
		if (existing?.isRunning) return existing;
		if (existing) {
			// Crashed mid-session. Record why so downstream reports the real cause
			// (a server that was running and died) instead of falling through to
			// "install <command>" advice for an already-installed server — and so
			// the one-time post-edit warning still fires. Don't respawn in a loop.
			startFailures.set(key, existing.error ?? "language server stopped unexpectedly");
			return undefined;
		}

		// Keyed on the command being spawned, not on where the config came from —
		// a plugin configuring typescript-language-server hits the same TS7 trap.
		if (target.command === "typescript-language-server") {
			const problem = typescriptPreflight(target.root);
			if (problem) {
				startFailures.set(key, problem);
				return undefined;
			}
		}

		if (target.plugin) mkdirSync(target.plugin.dataDir, { recursive: true });

		const client = new LspClient({ command: target.command, args: target.args }, target.root, target.options);
		clients.set(key, client);
		try {
			await client.start();
			return client;
		} catch (error) {
			startFailures.set(key, client.error ?? (error as Error).message);
			return undefined;
		}
	};

	/** One-time notice per server key so a missing server doesn't degrade silently. */
	const reportFailureOnce = (target: ResolvedTarget, notify: (message: string) => void) => {
		const failure = startFailures.get(target.key);
		if (failure && !warned.has(target.key)) {
			warned.add(target.key);
			// Server errors run to paragraphs; the transcript gets one line and
			// /lsp keeps the full status.
			const brief = failure.split("\n")[0].replace(/\s+/g, " ").trim();
			const capped = brief.length > 100 ? `${brief.slice(0, 99)}…` : brief;
			notify(`LSP unavailable for ${target.languageId}: ${capped} (/lsp for status)`);
		}
	};

	/** One-time notice when plugin LSP configs were invalid or collided. */
	const reportRoutingIssuesOnce = (ctx: ExtensionContext) => {
		const { collisions, diagnostics } = pluginRouting(ctx.cwd);
		if ((collisions.length === 0 && diagnostics.length === 0) || warned.has("plugin:routing")) return;
		warned.add("plugin:routing");
		if (!ctx.hasUI) return;
		const lines = [...diagnostics, ...collisions].slice(0, 4);
		ctx.ui.notify(`Plugin LSP config issues (/lsp for the full list):\n${lines.join("\n")}`, "warning");
	};

	/** All servers' current diagnostics, merged per document uri. */
	const mergedDiagnostics = (): Map<string, LspDiagnostic[]> => {
		const merged = new Map<string, LspDiagnostic[]>();
		for (const client of clients.values()) {
			for (const [uri, list] of client.allDiagnostics()) {
				const existing = merged.get(uri);
				merged.set(uri, existing ? [...existing, ...list] : list);
			}
		}
		return merged;
	};

	// tool_result fires on EVERY tool call; re-fingerprinting all delivered
	// diagnostics each round is pure waste when nothing republished. -1 forces
	// a scan (used after clear-on-edit, where cached diagnostics become
	// deliverable again without a new publish).
	let lastPublishTally = 0;
	const forceDeltaScan = () => {
		lastPublishTally = -1;
	};

	/** Format the pending delta and commit it as delivered; undefined when clean. */
	const takePendingDelta = (cwd: string): string | undefined => {
		if (clients.size === 0) return undefined;
		const tally = [...clients.values()].reduce((sum, client) => sum + client.publishCount, 0);
		if (tally === lastPublishTally) return undefined;
		lastPublishTally = tally;
		const delta = computeDelta(mergedDiagnostics(), tracker);
		const text = formatNewDiagnostics(delta, cwd);
		if (!text) return undefined;
		markDelivered(delta, tracker);
		return text;
	};

	// The transcript shows a compact ✳ headline (ctrl+o expands the block).
	pi.registerMessageRenderer(NEW_DIAGNOSTICS_TYPE, (message, { expanded }, theme) =>
		notificationComponent(theme, customMessageText(message.content), expanded),
	);

	pi.on("tool_result", async (event, ctx) => {
		// An edit/write is the one place a fresh publish can be usefully provoked:
		// sync the file, await the server's next publish, and reset the file's
		// delivered-set so a reintroduced issue resurfaces.
		if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string") {
				const target = resolveTarget(path, ctx.cwd);
				reportRoutingIssuesOnce(ctx);
				if (target) {
					const client = await clientFor(target);
					if (client) {
						tracker.clear(pathToUri(path));
						forceDeltaScan();
						await client.getDiagnostics(path, target.languageId);
					} else {
						reportFailureOnce(target, (message) => {
							if (ctx.hasUI) ctx.ui.notify(message, "warning");
						});
					}
				}
			}
		}

		// Every tool round drains whatever is newly known — including dependents
		// of an earlier edit whose diagnostics arrived while other tools ran.
		const text = takePendingDelta(ctx.cwd);
		if (text) {
			pi.sendMessage(
				{ customType: NEW_DIAGNOSTICS_TYPE, content: [{ type: "text", text }], display: true },
				// triggerTurn stays false: diagnostics attach to whatever turn comes
				// next; they never wake an idle agent on their own.
				{ deliverAs: "steer", triggerTurn: false },
			);
		}
	});

	// Diagnostics that finished publishing while the agent was idle (wakeup
	// turns, session resume) attach to the next run's start.
	pi.on("before_agent_start", (_event, ctx) => {
		const text = takePendingDelta(ctx.cwd);
		if (!text) return;
		return { message: { customType: NEW_DIAGNOSTICS_TYPE, content: [{ type: "text", text }], display: true } };
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "Diagnostics",
		...ccToolRenderers("Diagnostics"),
		description:
			"Ask the language server for diagnostics (type errors, warnings) on a file. Reflects the file's current contents. Supported: TypeScript/JavaScript, Python, Go, Rust, Java — plus any language a plugin's .lsp.json configures — when that language's server is installed.",
		parameters: Type.Object({
			path: Type.String({ description: "File to analyse (absolute or workspace-relative)" }),
			severity: Type.Optional(
				StringEnum(["error", "warning", "all"] as const, { description: "Minimum severity (default: all)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const path = params.path.startsWith("/") ? params.path : `${ctx.cwd}/${params.path}`;
			const target = resolveTarget(path, ctx.cwd);
			const client = target ? await clientFor(target) : undefined;
			if (!target || !client) {
				const failure = target ? startFailures.get(target.key) : undefined;
				return {
					content: [
						{
							type: "text",
							text:
								failure ??
								(target
									? `No language server available for ${target.languageId}. Install ${target.command}.`
									: `No language server is configured for this file type.`),
						},
					],
					details: { available: false },
					// A language was recognised but its server is unavailable/failed —
					// that is an error, not a clean "no diagnostics". Only a genuinely
					// unsupported filetype (no match) is a non-error outcome.
					isError: Boolean(target),
				};
			}

			const all = await client.getDiagnostics(path, target.languageId);
			// The model sees these in the tool result now; don't re-deliver them
			// as <new-diagnostics> on the next round.
			tracker.markDelivered(pathToUri(path), all.map(fingerprintDiagnostic));
			const filtered = filterDiagnostics(all, (params.severity ?? "all") as SeverityFilter);
			const relPath = relative(ctx.cwd, path) || path;
			return {
				content: [{ type: "text", text: formatDiagnostics(relPath, filtered) }],
				details: { count: filtered.length, languageId: target.languageId },
			};
		},
	});

	pi.registerCommand("lsp", {
		description: "Show language server status",
		handler: async (_args, ctx) => {
			const lines = [...clients.entries()].map(
				([key, client]) => `${client.isRunning ? "running" : "stopped"} ${key} (${client.diagnosticsCount} diagnostics)`,
			);
			for (const [key, failure] of startFailures) lines.push(`failed  ${key}: ${failure}`);
			if (routing) {
				for (const line of routing.diagnostics) lines.push(`config  ${line}`);
				for (const line of routing.collisions) lines.push(`routing ${line}`);
			}
			ctx.ui.notify(lines.length ? lines.join("\n") : "No language servers started.", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await Promise.all([...clients.values()].map((client) => client.stop()));
		clients.clear();
	});

	pi.events.emit(DEFER_CHANNEL, {
		name: "lsp_diagnostics",
		keywords: ["diagnostics", "errors", "type error", "typecheck", "compile", "lint", "lsp"],
	});
}
