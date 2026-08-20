/**
 * mcp extension — Model Context Protocol client, which pi deliberately omits.
 *
 * Servers are configured in Claude Code's format (`.mcp.json`, `~/.claude.json`)
 * and their tools are registered as `mcp__<server>__<tool>`, so existing Claude
 * Code MCP setups and permission rules work unchanged.
 *
 * Every MCP tool is registered deferred: a handful of servers can contribute
 * dozens of tools, and putting all those schemas in the system prompt is exactly
 * what `tool_search` exists to avoid.
 *
 * Servers are connected once per session (their tool lists are needed to
 * register anything) and closed on `session_shutdown`. In the interactive main
 * session the connect runs in the background so remote servers cannot delay
 * the prompt; one-shots and subagent children await it (findings §15).
 */

import os from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { MCP_TOOLS_CHANNEL } from "../lib/mcp-share.ts";
import { persistIfLarge } from "../lib/persisted-output.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import {
	callTool,
	close,
	type Connection,
	connect,
	type FailedConnection,
	isUnauthorized,
	mcpInstructionsReminder,
	readResource,
	readResourceDir,
} from "./client.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { join } from "node:path";
import {
	MCP_STATUS_CHANNEL,
	MCP_STATUS_REQUEST_CHANNEL,
	type McpServerStatus,
	type McpStatusEvent,
} from "../lib/mcp-status.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { readDisabledMcpServers, setMcpServerDisabled } from "../lib/mcp-overrides.ts";
import { boundedDockHeight, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { authenticate as runOAuthFlow, silentProvider } from "./oauth/flow.ts";
import { hasStoredTokens } from "./oauth/store.ts";
import { decodeMcpKey } from "./panel/keys.ts";
import { type McpEntry, type McpEntryStatus } from "./panel/model.ts";
import { renderMcpPanel, type McpPaint } from "./panel/render.ts";
import { applyMcpKey, initialMcpState, type McpEffect } from "./panel/state.ts";
import { loadServers, type McpServer } from "./config.ts";
import {
	describeContent,
	describeResourceContents,
	jsonSchemaToTypeBox,
	type McpContentBlock,
	type McpResourceContents,
	namespacedToolName,
} from "./schema.ts";

/** Shared "server name not found" tool result for the resource read/list-dir tools. */
function unknownServerError(name: string) {
	return {
		content: [{ type: "text" as const, text: `No connected MCP server named "${name}".` }],
		details: {} as { server?: string; uri?: string },
		isError: true,
	};
}

export default function mcpExtension(pi: ExtensionAPI) {
	const connections = new Map<string, Connection>();
	let failures: FailedConnection[] = [];
	const registered = new Set<string>();
	let servers: McpServer[] = [];
	// http servers that returned a 401 with no stored tokens — authNeeded via OAuth,
	// distinct from a missing-env authNeeded (which Authenticate cannot fix).
	const oauthNeeded = new Set<string>();
	// Servers the user disabled (persisted in ~/.onecode) — discovered but not connected.
	let disabledNames = new Set<string>();
	// Config file paths contributed by plugins, so the panel can group them.
	let pluginConfigPaths = new Set<string>();
	const home = os.homedir();
	// Live tool definitions, shared with in-process subagents so they reach MCP
	// through these same open connections instead of connecting their own.
	const sharedTools: ToolDefinition[] = [];

	/**
	 * Where oversized results are persisted — the session dir, matching Claude
	 * Code's `<session-dir>/tool-results/<id>.txt`. A session-less run (`--no-session`)
	 * has no such dir, so a temp folder serves; the model gets the path either way.
	 */
	const resultsDir = (ctx: ExtensionContext | undefined): string => {
		try {
			const dir = ctx?.sessionManager.getSessionDir();
			if (dir) return dir;
		} catch {
			// fall through to the temp folder
		}
		return join(os.tmpdir(), "one-code");
	};

	const registerToolsFor = (connection: Connection) => {
		for (const tool of connection.tools) {
			const name = namespacedToolName(connection.server.name, tool.name);
			if (registered.has(name)) continue;
			registered.add(name);

			const def: ToolDefinition = {
				name,
				label: `${connection.server.name}: ${tool.name}`,
				...ccToolRenderers(`${connection.server.name}: ${tool.name}`),
				description: tool.description ?? `MCP tool "${tool.name}" from server "${connection.server.name}".`,
				parameters: jsonSchemaToTypeBox(tool.inputSchema),
				async execute(toolCallId, params, _signal, _onUpdate, ctx) {
					const live = connections.get(connection.server.name);
					if (!live) {
						return {
							content: [{ type: "text", text: `MCP server "${connection.server.name}" is not connected.` }],
							details: {} as Record<string, unknown>,
							isError: true,
						};
					}
					try {
						const result = await callTool(live, tool.name, (params ?? {}) as Record<string, unknown>);
						const { text, images } = describeContent(result.content as McpContentBlock[] | undefined);
						return {
							content: [
								{
									type: "text",
									text: text ? persistIfLarge(text, { dir: resultsDir(ctx), id: toolCallId }) : "(no output)",
								},
								...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
							],
							details: { server: connection.server.name, tool: tool.name } as Record<string, unknown>,
							isError: result.isError === true,
						};
					} catch (error) {
						return {
							content: [{ type: "text", text: `MCP call failed: ${(error as Error).message}` }],
							details: { server: connection.server.name, tool: tool.name } as Record<string, unknown>,
							isError: true,
						};
					}
				},
			};
			pi.registerTool(def);
			sharedTools.push(def);

			// Deferred: the model discovers these through tool_search.
			pi.events.emit(DEFER_CHANNEL, {
				name,
				keywords: [connection.server.name, tool.name.replace(/[_-]/g, " "), "mcp"],
			});
		}
		// Publish the live set so in-process subagents can share these connections.
		if (sharedTools.length > 0) pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [...sharedTools] });
	};

	/** Resolves when every configured server has connected or failed. */
	let connecting: Promise<void> | undefined;
	let connectSettled = false;
	let shuttingDown = false;

	/**
	 * Connect one server, updating the live maps. Prior failure/authNeeded state
	 * for the server is cleared first, so this doubles as the reconnect path.
	 *   - An http server with stored OAuth tokens connects with the silent
	 *     provider (refreshing as needed); without tokens it connects with NO
	 *     provider so a 401 throws instead of popping a browser at startup.
	 *   - A 401 from an http server marks it authNeeded (OAuth); any other error
	 *     is a hard failure.
	 */
	/**
	 * Record a freshly established connection as the live one for its server:
	 * clear stale failure/authNeeded state, register its tools (and resource
	 * tools), and surface any listTools warnings. The single "now connected"
	 * path — both connectOne and the OAuth flow route through it, so neither can
	 * drift (e.g. drop the warnings step).
	 */
	const adoptConnection = (server: McpServer, connection: Connection): void => {
		failures = failures.filter((f) => f.server.name !== server.name);
		oauthNeeded.delete(server.name);
		connections.set(server.name, connection);
		registerToolsFor(connection);
		for (const warning of connection.warnings) failures.push({ server, error: warning });
		if (connection.resources.length > 0) registerResourceTools();
	};

	const connectOne = async (server: McpServer): Promise<void> => {
		failures = failures.filter((f) => f.server.name !== server.name);
		oauthNeeded.delete(server.name);
		const provider = server.kind === "http" && hasStoredTokens(server.name) ? silentProvider(server.name) : undefined;
		try {
			const connection = await connect(server, provider);
			if (shuttingDown) {
				await close(connection);
				return;
			}
			adoptConnection(server, connection);
		} catch (error) {
			if (shuttingDown) return;
			if (server.kind === "http" && isUnauthorized(error)) oauthNeeded.add(server.name);
			else failures.push({ server, error: (error as Error).message });
		}
	};

	/**
	 * Re-publish servers' own usage instructions (initialize result) as an
	 * every-turn reminder, the way Claude Code injects them (findings §14).
	 * Re-run after a reconnect/authenticate so a newly connected server's
	 * instructions appear too.
	 */
	const emitInstructions = () => {
		const instructions = mcpInstructionsReminder([...connections.values()]);
		if (instructions) {
			pi.events.emit(REMINDER_CHANNEL, {
				scope: "every-turn",
				key: "mcp-instructions",
				text: instructions,
				placement: "first-prepend",
				order: CONTEXT_ORDER.mcp,
			});
		} else {
			// No server has instructions anymore (e.g. the last one was disabled or
			// disconnected) — drop the stale every-turn reminder so the model stops
			// being told to use tools that are gone.
			pi.events.emit(REMINDER_CHANNEL, { scope: "every-turn", key: "mcp-instructions", text: "", remove: true });
		}
	};

	const connectAll = async (ctx: ExtensionContext) => {
		pluginConfigPaths = new Set(discoverPlugins(defaultDiscoverRoots(getAgentDir(), ctx.cwd)).mcpConfigs);
		servers = loadServers(ctx.cwd, home, process.env, [...pluginConfigPaths]);
		disabledNames = readDisabledMcpServers(ctx.cwd, home);
		if (servers.length === 0) return;

		// Disabled servers are listed but never connected; a server with an unset
		// credential env var stays "needs authentication" and is not attempted
		// (connecting with an empty token fails confusingly). Everything else connects.
		await Promise.all(
			servers
				.filter((server) => !disabledNames.has(server.name) && !server.missingEnv?.length)
				.map(connectOne),
		);

		if (shuttingDown) return;

		if (failures.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				failures.map((f) => `MCP server "${f.server.name}" failed: ${f.error}`).join("\n") + " (/mcp for status)",
				"warning",
			);
		}
		if (oauthNeeded.size > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`${oauthNeeded.size} MCP server${oauthNeeded.size === 1 ? "" : "s"} need authentication — run /mcp to authenticate.`,
				"warning",
			);
		}

		emitInstructions();
	};

	let resourceToolsRegistered = false;
	const registerResourceTools = () => {
		if (resourceToolsRegistered) return;
		resourceToolsRegistered = true;

		pi.registerTool({
			name: "list_mcp_resources",
			label: "MCP Resources",
			...ccToolRenderers("MCP Resources"),
			description:
				"List resources exposed by connected MCP servers. Resources are readable documents or data the server offers, addressed by uri.",
			parameters: Type.Object({
				server: Type.Optional(Type.String({ description: "Limit to one server by name" })),
			}),
			async execute(_toolCallId, params) {
				// A bad `server` name must not read back as "this server has zero
				// resources" — validate it like read_mcp_resource does, else a typo
				// looks like an empty (but real) server.
				if (params.server && !connections.has(params.server)) {
					return {
						content: [
							{
								type: "text",
								text: `No connected MCP server named "${params.server}". Connected servers: ${[...connections.keys()].join(", ") || "none"}.`,
							},
						],
						details: { count: 0 },
						isError: true,
					};
				}
				const lines: string[] = [];
				for (const connection of connections.values()) {
					if (params.server && connection.server.name !== params.server) continue;
					for (const resource of connection.resources) {
						lines.push(
							`${connection.server.name} ${resource.uri}${resource.name ? ` — ${resource.name}` : ""}${resource.description ? `: ${resource.description}` : ""}`,
						);
					}
				}
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n") : "No MCP resources available." }],
					details: { count: lines.length },
				};
			},
		});

		pi.registerTool({
			name: "read_mcp_resource",
			label: "Read MCP Resource",
			...ccToolRenderers("Read MCP Resource"),
			description: "Read one resource from an MCP server by uri. Use list_mcp_resources to find uris.",
			parameters: Type.Object({
				server: Type.String({ description: "Server name that owns the resource" }),
				uri: Type.String({ description: "Resource uri" }),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const connection = connections.get(params.server);
				if (!connection) return unknownServerError(params.server);
				try {
					const result = await readResource(connection, params.uri);
					const text = describeResourceContents(result.contents as McpResourceContents[] | undefined);
					return {
						content: [
							{
								type: "text",
								text: text ? persistIfLarge(text, { dir: resultsDir(ctx), id: toolCallId }) : "(empty resource)",
							},
						],
						details: { server: params.server, uri: params.uri },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Could not read ${params.uri}: ${(error as Error).message}` }],
						details: { server: params.server, uri: params.uri },
						isError: true,
					};
				}
			},
		});

		pi.registerTool({
			name: "read_mcp_resource_dir",
			label: "List MCP Resource Directory",
			...ccToolRenderers("List MCP Resource Directory"),
			description:
				'List the direct children of a directory resource on an MCP server (resources/directory/read). Not recursive: each entry carries its own uri, and subdirectories appear with mimeType "inode/directory" — call again on a subdirectory uri to descend. Only servers that support directory listing accept this; others return an error.',
			parameters: Type.Object({
				server: Type.String({ description: "Server name that owns the directory" }),
				uri: Type.String({ description: "The directory resource uri to list" }),
			}),
			async execute(_toolCallId, params) {
				const connection = connections.get(params.server);
				if (!connection) return unknownServerError(params.server);
				try {
					const result = await readResourceDir(connection, params.uri);
					const entries = (result.resources ?? result.entries ?? []) as Array<{ uri?: string; name?: string; mimeType?: string }>;
					const lines = entries.map((e) => `${e.uri ?? "(no uri)"}${e.name ? ` — ${e.name}` : ""}${e.mimeType ? ` (${e.mimeType})` : ""}`);
					return {
						content: [{ type: "text", text: lines.length ? lines.join("\n") : "(empty directory)" }],
						details: { server: params.server, uri: params.uri },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Could not list ${params.uri}: ${(error as Error).message}` }],
						details: { server: params.server, uri: params.uri },
						isError: true,
					};
				}
			},
		});

		for (const name of ["list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir"]) {
			pi.events.emit(DEFER_CHANNEL, { name, keywords: ["mcp", "resource", "document", "uri", "directory"] });
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// pi awaits session_start handlers serially before the prompt opens, and
		// remote servers take seconds to answer — awaiting here was the entire
		// "slow startup" (4.9s → 0.24s measured, findings §15). In the interactive
		// main session the connect runs in the background: tools register as each
		// server answers (tool_search handles late defers), and /mcp shows
		// "connecting" until it settles. Print-mode one-shots and subagent RPC
		// children still await — their single turn starts immediately and would
		// race past tools that are not registered yet.
		connecting = connectAll(ctx).catch((error) => {
			// A rejection here would otherwise be an unhandled-promise crash in
			// the background path; per-server failures are already collected in
			// `failures`, so this only catches setup bugs — surface them loud.
			if (ctx.hasUI) ctx.ui.notify(`MCP startup failed: ${(error as Error).message}`, "error");
		});
		connecting.finally(() => {
			connectSettled = true;
			// Final publish, marked settled — emitted even with zero servers/tools so
			// a consumer that spawns children early (subagents) can stop waiting for
			// late-connecting servers instead of snapshotting an empty set forever.
			pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [...sharedTools], settled: true });
		});
		if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) {
			await connecting;
		}
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await Promise.all([...connections.values()].map((connection) => close(connection)));
		connections.clear();
	});

	// Single source of truth for a server's status, shared by the /plugins status
	// snapshot, the /mcp panel entries, and the text fallback.
	const deriveStatus = (server: McpServer): { status: McpEntryStatus; detail?: string; toolCount?: number } => {
		if (disabledNames.has(server.name)) return { status: "disabled" };
		const connection = connections.get(server.name);
		if (connection) {
			// A server can connect yet warn (e.g. listTools/listResources failed);
			// adoptConnection files those under `failures`. Surface it so the warning
			// isn't collected-but-invisible.
			const warning = failures.find((f) => f.server.name === server.name);
			return { status: "connected", toolCount: connection.tools.length, detail: warning?.error };
		}
		if (oauthNeeded.has(server.name)) return { status: "authNeeded" };
		if (server.missingEnv?.length) {
			return { status: "authNeeded", detail: `${server.missingEnv.join(", ")} not set in the environment` };
		}
		const failure = failures.find((f) => f.server.name === server.name);
		if (failure) return { status: "failed", detail: failure.error };
		return connectSettled ? { status: "failed", detail: "not connected" } : { status: "connecting" };
	};

	// The /plugins panel can't import this extension's state (jiti gives every
	// extension its own module instance), and the bus doesn't replay — so it
	// asks: a request event answered with a status snapshot.
	const buildStatusSnapshot = (): McpServerStatus[] =>
		servers.map((server) => {
			const { status, detail, toolCount } = deriveStatus(server);
			return { name: server.name, status, detail, toolCount, source: server.source };
		});

	pi.events.on(MCP_STATUS_REQUEST_CHANNEL, () => {
		pi.events.emit(MCP_STATUS_CHANNEL, { servers: buildStatusSnapshot(), settled: connectSettled } satisfies McpStatusEvent);
	});

	// --- /mcp panel ------------------------------------------------------------

	const shorten = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

	// One place that turns a server's config source into its display group, sort
	// rank, config-location label, and disable-persistence scope — so the four
	// can't drift apart. Plugin servers persist at project scope (mcp-overrides
	// has no plugin scope; per-repo is the right default for a plugin).
	interface Provenance {
		rank: number;
		group: string;
		configLocation: string;
		scope: "user" | "project";
	}
	const classify = (server: McpServer): Provenance => {
		if (pluginConfigPaths.has(server.source)) {
			return { rank: 3, group: "Plugin MCPs", configLocation: "Plugin configuration", scope: "project" };
		}
		if (server.source === join(home, ".claude.json")) {
			return { rank: 0, group: `User MCPs (${shorten(server.source)})`, configLocation: shorten(server.source), scope: "user" };
		}
		if (server.source.endsWith(join(".claude", "settings.local.json"))) {
			return { rank: 2, group: "Project MCPs (.claude/settings.local.json)", configLocation: shorten(server.source), scope: "project" };
		}
		return { rank: 1, group: `Project MCPs (${shorten(server.source)})`, configLocation: shorten(server.source), scope: "project" };
	};

	const buildEntries = (): McpEntry[] =>
		servers
			.map((server) => {
				const { status, detail, toolCount } = deriveStatus(server);
				const { rank, group, configLocation } = classify(server);
				const canAuthenticate = server.kind === "http" && !server.missingEnv?.length;
				// Issue line for hard failures, for an env-missing authNeeded (so the user
				// sees which variable to set), and for a connected-but-warning server; an
				// OAuth authNeeded needs no issue — the Authenticate action speaks for itself.
				const issue =
					status === "failed" || status === "connected" || (status === "authNeeded" && !canAuthenticate) ? detail : undefined;
				// Auth line shown on a failed http server (as Claude Code does), read
				// honestly from whether tokens are stored — not just "failed http".
				const authState =
					status === "failed" && server.kind === "http"
						? hasStoredTokens(server.name)
							? ("authenticated" as const)
							: ("notAuthenticated" as const)
						: undefined;
				const entry: McpEntry = {
					name: server.name,
					group,
					status,
					toolCount,
					issue,
					url: server.kind === "http" ? server.url : undefined,
					configLocation,
					authState,
					canAuthenticate,
				};
				return { entry, rank };
			})
			.sort((a, b) =>
				a.rank !== b.rank
					? a.rank - b.rank
					: a.entry.group === b.entry.group
						? a.entry.name.localeCompare(b.entry.name)
						: a.entry.group.localeCompare(b.entry.group),
			)
			.map((e) => e.entry);

	/** Bounded dock like /skills and /plugins — keeps the transcript visible above. */
	const MCP_PANEL_MAX_HEIGHT = 22;

	const openMcpPanel = async (ctx: ExtensionContext): Promise<void> => {
		await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
			const paint: McpPaint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };
			const state = initialMcpState();
			let notices: string[] = [];
			const busy = new Set<string>();
			let cache: { width: number; lines: string[] } | undefined;
			// The entry list is derived from live connection state; build it once and
			// rebuild only when that state changes (an action lands, or the ticker
			// sees connects still settling) — never per render frame or per keystroke.
			let entries = buildEntries();
			const repaint = () => {
				cache = undefined;
				tui.requestRender();
			};
			const syncRepaint = () => {
				entries = buildEntries();
				repaint();
			};
			// Animate while connecting or an action is in flight; real changes repaint explicitly.
			const ticker = setInterval(() => {
				if (busy.size > 0 || !connectSettled) syncRepaint();
			}, 500);
			ticker.unref?.();

			// Message after a (re)connect attempt: silent on success, else name the
			// reason from the freshly derived status (auth vs a hard failure).
			const outcomeNotice = (server: McpServer): string[] => {
				const status = deriveStatus(server).status;
				if (status === "connected") return [];
				if (status === "authNeeded") return [`"${server.name}" needs authentication.`];
				return [`"${server.name}" could not connect.`];
			};

			const runReconnect = async (entry: McpEntry) => {
				const server = servers.find((s) => s.name === entry.name);
				if (!server || busy.has(entry.name)) return;
				busy.add(entry.name);
				notices = [`Reconnecting to "${entry.name}"…`];
				syncRepaint();
				const existing = connections.get(entry.name);
				if (existing) {
					connections.delete(entry.name);
					await close(existing);
				}
				await connectOne(server);
				emitInstructions();
				notices = outcomeNotice(server);
				busy.delete(entry.name);
				syncRepaint();
			};

			const runDisable = (entry: McpEntry) => {
				const server = servers.find((s) => s.name === entry.name);
				if (!server || busy.has(entry.name)) return; // don't cut across an in-flight connect
				setMcpServerDisabled(entry.name, true, classify(server).scope, ctx.cwd, home);
				disabledNames.add(entry.name);
				const existing = connections.get(entry.name);
				if (existing) {
					connections.delete(entry.name);
					void close(existing);
				}
				state.detail = undefined;
				emitInstructions(); // drops the disabled server's instructions reminder
				notices = [`Disabled "${entry.name}". Its tools stay unavailable until re-enabled.`];
				syncRepaint();
			};

			const runEnable = async (entry: McpEntry) => {
				const server = servers.find((s) => s.name === entry.name);
				if (!server || busy.has(entry.name)) return;
				setMcpServerDisabled(entry.name, false, classify(server).scope, ctx.cwd, home);
				disabledNames.delete(entry.name);
				busy.add(entry.name);
				notices = [`Enabling "${entry.name}"…`];
				syncRepaint();
				await connectOne(server);
				emitInstructions();
				busy.delete(entry.name);
				notices = outcomeNotice(server);
				syncRepaint();
			};

			const runAuthenticate = async (entry: McpEntry) => {
				const server = servers.find((s) => s.name === entry.name);
				if (!server || busy.has(entry.name)) return;
				if (server.kind !== "http") {
					notices = [`"${entry.name}" is not an http server; OAuth is unavailable.`];
					repaint();
					return;
				}
				busy.add(entry.name);
				notices = [`Starting authorization for "${entry.name}"…`];
				syncRepaint();
				try {
					const connection = await runOAuthFlow({
						server,
						home,
						onPrompt: (message) => {
							notices = message.split("\n");
							repaint();
						},
					});
					adoptConnection(server, connection);
					emitInstructions();
					notices = [`Authenticated "${entry.name}".`];
				} catch (error) {
					notices = [`Authentication failed: ${(error as Error).message}`];
				} finally {
					busy.delete(entry.name);
					syncRepaint();
				}
			};

			const runEffect = (effect: McpEffect) => {
				switch (effect.kind) {
					case "close":
						clearInterval(ticker);
						done(null);
						return;
					case "reconnect":
						void runReconnect(effect.entry);
						return;
					case "disable":
						runDisable(effect.entry);
						return;
					case "enable":
						void runEnable(effect.entry);
						return;
					case "authenticate":
						void runAuthenticate(effect.entry);
						return;
				}
			};

			return {
				render: (width: number) => {
					if (cache?.width === width) return cache.lines;
					const termRows = (tui as { terminal: { rows: number } }).terminal.rows;
					const height = boundedDockHeight(termRows, MCP_PANEL_MAX_HEIGHT);
					const lines = renderMcpPanel(
						{ state, entries, width, height, notices, settled: connectSettled },
						paint,
					).map((line) => truncateLine(line, width));
					cache = { width, lines };
					return lines;
				},
				handleInput: (data: string) => {
					const key = decodeMcpKey(data);
					if (!key) return;
					// Navigation reads the cached entries; effects (which change the
					// underlying state) rebuild them via syncRepaint inside their handlers.
					const effect = applyMcpKey(state, key, entries);
					if (effect) runEffect(effect);
					repaint();
				},
				invalidate: () => {
					cache = undefined;
				},
				dispose: () => {
					clearInterval(ticker);
				},
			};
		});
	};

	pi.registerCommand("mcp", {
		description: "Manage MCP servers (status, reconnect, authenticate, enable/disable)",
		handler: async (_args, ctx) => {
			if (servers.length === 0) {
				ctx.ui.notify("No MCP servers configured. Add them to .mcp.json or ~/.claude.json.", "info");
				return;
			}
			if (ctx.hasUI) {
				await openMcpPanel(ctx);
				return;
			}
			// Non-interactive fallback: a flat status listing, with tool/resource
			// counts and any warning for connected servers.
			const lines = servers.map((server) => {
				const { status, detail } = deriveStatus(server);
				const connection = connections.get(server.name);
				let suffix = "";
				if (connection) {
					suffix = ` — ${connection.tools.length} tools, ${connection.resources.length} resources`;
					if (detail) suffix += ` — WARNING: ${detail}`;
				} else if (detail) {
					suffix = ` — ${detail}`;
				}
				return `${status.padEnd(12)} ${server.name}${suffix} (${server.source})`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
