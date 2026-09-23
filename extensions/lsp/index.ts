/**
 * lsp extension — language-server diagnostics, the way Claude Code surfaces them.
 *
 * Three behaviors:
 *  1. A session-wide watcher (watcher.ts): new diagnostics — cross-file, all
 *     severities, deduplicated against what was already delivered — ride the
 *     tool result of the round that surfaced them as a raw `<new-diagnostics>`
 *     block (a reminder-queue one-shot, pinned to the trailing tool result
 *     after the `<total_tokens>` line — the exact place a Claude Code session
 *     shows them), or the message that opens the next run when they arrived
 *     while idle (`agent_start`, so a notification-opened run gets them too).
 *     Until 2026-09-05 they went out as a custom steer message of their own
 *     (a separate user turn on the wire). Editing a file clears its
 *     delivered-set so fixed-then-reintroduced issues resurface.
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
import { absoluteFrom } from "../lib/paths.ts";
import { defaultDiscoverRoots, discoverPlugins, pluginResources } from "../lib/plugins.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../lib/reminders.ts";
import { ccToolRenderers, cutPlainText } from "../lib/tui-render.ts";
import { LspClient, type LspClientOptions, pathToUri } from "./client.ts";
import { filterDiagnostics, formatDiagnostics, type LspDiagnostic, type SeverityFilter } from "./format.ts";
import { describeStartFailure, INSTALL_HINTS } from "./install-hints.ts";
import { withKeepAlive } from "./keep-alive.ts";
import {
	pluginLanguageId,
	readManifestLspServers,
	type ResolvedPluginServer,
	resolveExtensionRouting,
	resolvePluginServers,
} from "./plugin-servers.ts";
import { findProjectRoot, serverForPath, typescriptPreflight } from "./servers.ts";
import { computeDelta, DeliveredTracker, fingerprintDiagnostic, formatNewDiagnostics, markDelivered } from "./watcher.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { findProjectRoot as findRepoRoot } from "../lib/git.ts";
import { isLspRootTrusted, PROJECT_CODE_REASON, PROJECT_CODE_SERVERS, persistLspTrust } from "./trust.ts";

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

	/** Servers may be respawned this many times after a mid-session crash; beyond that the language is off for the session. */
	const MAX_RESPAWNS = 2;
	const respawns = new Map<string, number>();

	const clientFor = async (target: ResolvedTarget, ctx: ExtensionContext): Promise<LspClient | undefined> => {
		const { key } = target;
		if (startFailures.has(key)) return undefined;

		const existing = clients.get(key);
		if (existing?.isRunning) return existing;
		// A server that runs project code starts only in a trusted project
		// (trust.ts); checked here so no caller can spawn one without it.
		if (!(await projectCodeAllowed(target, ctx))) return undefined;
		if (existing) {
			// Crashed mid-session. Respawn with a short backoff, up to MAX_RESPAWNS
			// times; after that record why so downstream reports the real cause (a
			// server that was running and died) instead of falling through to
			// "install <command>" advice for an already-installed server — and so
			// the one-time post-edit warning still fires (review T10).
			const count = (respawns.get(key) ?? 0) + 1;
			respawns.set(key, count);
			if (count > MAX_RESPAWNS) {
				startFailures.set(key, `${existing.error ?? "language server stopped unexpectedly"} (gave up after ${MAX_RESPAWNS} restarts)`);
				return undefined;
			}
			clients.delete(key);
			await new Promise((resolve) => setTimeout(resolve, 500 * count));
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
			// A missing binary (spawn ENOENT) is rewritten into install guidance
			// here, once, so the warning, /lsp, and the tool all show it.
			const raw = client.error ?? (error as Error).message;
			startFailures.set(key, describeStartFailure(raw, target.command, target.plugin?.pluginName));
			return undefined;
		}
	};

	/**
	 * Consent for a built-in server that runs the project's own code
	 * (trust.ts): trusted project → start; otherwise ask once per project in an
	 * interactive session, and with no UI or a "no" leave it off with a
	 * not-started failure the one-time notice and /lsp report.
	 */
	const sessionTrust = new Map<string, boolean>();
	/** Server roots found trusted on disk this process, so the store is read once per root. */
	const trustedServerRoots = new Set<string>();
	const pendingTrust = new Map<string, Promise<boolean>>();
	const trustRoot = (cwd: string) => findRepoRoot(cwd) ?? cwd;
	const NOT_TRUSTED = "not started:";
	const projectCodeAllowed = async (target: ResolvedTarget, ctx: ExtensionContext): Promise<boolean> => {
		if (target.plugin || !PROJECT_CODE_SERVERS.has(target.command)) return true;
		const root = trustRoot(ctx.cwd);
		if (sessionTrust.get(root) === true || trustedServerRoots.has(target.root)) return true;
		if (isLspRootTrusted(target.root)) {
			trustedServerRoots.add(target.root);
			return true;
		}
		const why = PROJECT_CODE_REASON[target.command] ?? "runs this project's code";
		if (sessionTrust.get(root) === undefined && ctx.hasUI) {
			let pending = pendingTrust.get(root);
			if (!pending) {
				pending = ctx.ui
					.confirm(
						`Start ${target.command} in this project?`,
						`${target.command} ${why}. Allow it only for a project you trust.\n\nThe answer for ${root} is remembered; /lsp trust allows it later.`,
					)
					.then((answer) => {
						const ok = answer === true;
						sessionTrust.set(root, ok);
						if (ok) persistLspTrust(root);
						return ok;
					})
					.finally(() => pendingTrust.delete(root));
				pendingTrust.set(root, pending);
			}
			if (await pending) return true;
		}
		if (!startFailures.has(target.key)) {
			startFailures.set(target.key, `${NOT_TRUSTED} ${target.command} ${why}, and this project is not trusted (run /lsp trust to allow it)`);
		}
		return false;
	};

	/** One-time notice per server key so a missing server doesn't degrade silently. */
	const reportFailureOnce = (target: ResolvedTarget, notify: (message: string) => void) => {
		const failure = startFailures.get(target.key);
		if (failure && !warned.has(target.key)) {
			warned.add(target.key);
			// Server errors run to paragraphs; the transcript gets one line and
			// /lsp keeps the full status. The cap leaves room for a full
			// missing-binary line including its install command.
			const brief = failure.split("\n")[0].replace(/\s+/g, " ").trim();
			const capped = cutPlainText(brief, 160);
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

	/**
	 * Queue the block where the model reads next. Raw (no `<system-reminder>`
	 * frame, as in Claude Code) and last-append: from a `tool_result` hook this
	 * extension runs after system-reminder's, so the one-shot is pending at the
	 * next `context` and pinned to the trailing tool result (process memory,
	 * same mechanism as the file-tracker's per-round report); from `agent_start`
	 * it pins to the message that opened the run.
	 */
	const queueNewDiagnostics = (text: string) => {
		pi.events.emit(REMINDER_CHANNEL, { text, placement: "last-append", raw: true } satisfies ReminderPayload);
	};

	pi.on("tool_result", async (event, ctx) => {
		// An edit/write is the one place a fresh publish can be usefully provoked:
		// sync the file, await the server's next publish, and reset the file's
		// delivered-set so a reintroduced issue resurfaces.
		if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
			const raw = (event.input as { path?: unknown }).path;
			if (typeof raw === "string") {
				// One absolute spelling for everything below: the server key (root),
				// the delivered-set URI and the diagnostics request. A relative path
				// used to yield root `.` and a URI keyed on process.cwd(), so one file
				// could end up on a second server instance (findings §23).
				const path = absoluteFrom(ctx.cwd, raw);
				const target = resolveTarget(path, ctx.cwd);
				reportRoutingIssuesOnce(ctx);
				if (target) {
					// withKeepAlive: in a one-shot run this await can be the only
					// pending work, and everything the client holds is unref'd —
					// without a ref the loop drains and pi exits mid-tool (keep-alive.ts).
					await withKeepAlive(async () => {
						const client = await clientFor(target, ctx);
						if (client) {
							tracker.clear(pathToUri(path));
							forceDeltaScan();
							await client.getDiagnostics(path, target.languageId);
						} else {
							reportFailureOnce(target, (message) => {
								if (ctx.hasUI) ctx.ui.notify(message, "warning");
							});
						}
					});
				}
			}
		}

		// Every tool round drains whatever is newly known — including dependents
		// of an earlier edit whose diagnostics arrived while other tools ran.
		// Diagnostics never wake an idle agent: a one-shot waits for the next
		// request, whoever opens it.
		const text = takePendingDelta(ctx.cwd);
		if (text) queueNewDiagnostics(text);
	});

	// Diagnostics that finished publishing while the agent was idle (session
	// resume, a server still typechecking after the turn ended) ride the message
	// that opens the next run. `agent_start`, not `before_agent_start`: pi emits
	// the latter only from `prompt()`, so a run a harness notification opened
	// (a `/loop` tick, an agent report) never fired it (STEERING-REVIEW H1).
	pi.on("agent_start", (_event, ctx) => {
		const text = takePendingDelta(ctx.cwd);
		if (text) queueNewDiagnostics(text);
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
			const path = absoluteFrom(ctx.cwd, params.path);
			const target = resolveTarget(path, ctx.cwd);
			// One keep-alive spans both awaits (same pattern as the tool_result hook).
			const fetched = target
				? await withKeepAlive(async () => {
						const client = await clientFor(target, ctx);
						return client && { all: await client.getDiagnostics(path, target.languageId) };
					})
				: undefined;
			if (!target || !fetched) {
				const failure = target ? startFailures.get(target.key) : undefined;
				return {
					content: [
						{
							type: "text",
							text:
								failure ??
								(target
									? `No language server available for ${target.languageId}. ` +
										(INSTALL_HINTS[target.command]
											? `Install it with: ${INSTALL_HINTS[target.command]}`
											: `Install ${target.command}.`)
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

			const { all } = fetched;
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

	registerLocalCommand(pi, "lsp", {
		description: "Show language server status: /lsp [trust]",
		getArgumentCompletions: () => [
			{ value: "trust", label: "let servers that run this project's code start here (rust-analyzer, jdtls)" },
		],
		handler: async (args, ctx) => {
			if (args.trim() === "trust") {
				const root = trustRoot(ctx.cwd);
				persistLspTrust(root);
				sessionTrust.set(root, true);
				for (const [key, failure] of startFailures) {
					if (failure.startsWith(NOT_TRUSTED)) {
						startFailures.delete(key);
						warned.delete(key);
					}
				}
				ctx.ui.notify(`Trusted ${root}: rust-analyzer and jdtls may start here. They run this project's build code.`, "info");
				return;
			}
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
