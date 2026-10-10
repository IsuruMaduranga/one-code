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
import { isDeepStrictEqual } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { MCP_TOOLS_CHANNEL } from "../lib/mcp-share.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import {
	callTool,
	close,
	type Connection,
	connect,
	type FailedConnection,
	isUnauthorized,
	mcpFailuresReminder,
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
import { announcedFrom, applyMcpDelta, emptyAnnounced, mcpAnnouncedBaseline, mcpAnnouncedFromReminders, mcpChangeNotices, mcpDelta, serializeMcpAnnounced, type McpAnnounced, type McpSnapshot, mcpStartupNotices } from "./announce.ts";
import { CONTEXT_BASELINE_CHANNEL, restoredContext } from "../lib/context-stack.ts";
import { decodeMcpKey } from "./panel/keys.ts";
import { type McpEntry, type McpEntryStatus } from "./panel/model.ts";
import { renderMcpPanel, type McpPaint } from "./panel/render.ts";
import { applyMcpKey, initialMcpState, type McpEffect } from "./panel/state.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { loadServers, type McpServer, piMcpConfigPaths, registeredMcpServers } from "./config.ts";
import { approveMcpServers, type McpTrustDeps, persistApproval, projectRootOf, reconnectRefusal } from "./trust.ts";
import {
	capDescription,
	describeContent,
	describeResourceContents,
	jsonSchemaToTypeBox,
	type McpContentBlock,
	type McpResourceContents,
	namespacedToolName,
} from "./schema.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { canShowCustomUi, notifyRpcReadOnly } from "../lib/headless-output.ts";
import { claudeSourcesOn } from "../lib/config-mode.ts";
import { claudeJsonPath } from "../lib/paths.ts";
import { consentDialog, startupConsentReady } from "../lib/consent-dialogs.ts";

/** Anthropic's hard limit on a tool name; a longer one fails the whole request. */
const MAX_TOOL_NAME_LENGTH = 128;

/** Shared "server name not found" tool result for the resource read/list-dir tools. */
function unknownServerError(name: string) {
	return {
		content: [{ type: "text" as const, text: `No connected MCP server named "${name}".` }],
		details: {} as { server?: string; uri?: string },
		isError: true,
	};
}

/** pi's own `mcp.json` files, read because our `/mcp` replaces pi 0.99's built-in MCP (config.ts). */
const piMcpConfigs = (cwd: string) => piMcpConfigPaths(getAgentDir(), cwd, CONFIG_DIR_NAME);

export default function mcpExtension(pi: ExtensionAPI) {
	const connections = new Map<string, Connection>();
	let failures: FailedConnection[] = [];
	const registered = new Map<string, { server: string; tool: string }>();
	let servers: McpServer[] = [];
	// http servers that returned a 401 with no stored tokens — authNeeded via OAuth,
	// distinct from a missing-env authNeeded (which Authenticate cannot fix).
	const oauthNeeded = new Set<string>();
	// Servers the user disabled (persisted in ~/.onecode) — discovered but not connected.
	let disabledNames = new Set<string>();
	// Project .mcp.json servers withheld this session (no consent yet, declined,
	// or disabled via Claude Code's disabledMcpjsonServers) — listed, not connected.
	const withheldNames = new Map<string, string>();
	// Config file paths contributed by plugins, so the panel can group them.
	let pluginConfigPaths = new Set<string>();
	// pi 0.99's registry of servers other extensions register; absent on older pi.
	// Registered after the session started: our servers are read once per session.
	pi.on("mcp_servers_change", (_event, ctx) => {
		const text = "An extension changed its MCP servers; run /reload to connect the change.";
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		else process.stderr.write(`${text}\n`);
	});
	const home = os.homedir();
	// Live tool definitions, shared with in-process subagents so they reach MCP
	// through these same open connections instead of connecting their own.
	const sharedTools: ToolDefinition[] = [];
	// Message 1 carries the MCP instructions and failed-servers reminders. Once a
	// request has gone out it is part of every later request's cached prefix, so
	// those blocks are frozen and later changes ride one-shot notices (./announce.ts).
	let requestSent = false;
	let announced = emptyAnnounced();
	/** A resumed snapshot from before structured baselines: its MCP blocks, until the server names are known. */
	let legacyBlocks: { instructions?: string; failures?: string } | undefined;
	pi.on("context", () => {
		requestSent = true;
	});

	/**
	 * Where oversized results are persisted — the session dir, matching Claude
	 * Code's `<session-dir>/tool-results/<id>.txt`. A session-less run (`--no-session`)
	 * has no such dir, so a temp folder serves; the model gets the path either way.
	 */
	const resultsDir = (ctx: ExtensionContext | undefined): string => sessionResultsDir(ctx);

	const registerToolsFor = (connection: Connection) => {
		// Names other extensions own, read once per batch (getAllTools builds every definition).
		let taken: Set<string> | undefined;
		for (const tool of connection.tools) {
			const name = namespacedToolName(connection.server.name, tool.name);
			// Anthropic caps a tool name at 128 characters and rejects the whole
			// request when one is longer — and a deferred definition rides every
			// request from request 1, so one over-long name would fail every turn
			// of the session with an opaque `tools.N.custom.name` error. Drop it
			// here with a clear reason instead.
			if (name.length > MAX_TOOL_NAME_LENGTH) {
				failures.push({
					server: connection.server,
					error: `tool "${tool.name}" skipped: its namespaced name is ${name.length} characters, over the ${MAX_TOOL_NAME_LENGTH}-character limit the provider enforces`,
				});
				continue;
			}
			const owner = registered.get(name);
			// An unchanged tool on reconnect keeps its exact definition and loaded
			// state. Only a different raw server/tool pair is a name collision.
			if (owner?.server === connection.server.name && owner.tool === tool.name) continue;
			if (owner || (taken ??= new Set(pi.getAllTools().map((existing) => existing.name))).has(name)) {
				// Two tools sanitise to one name (`a.b` and `a_b`, or a server
				// reconnecting under a stale registration). Skipping silently would
				// make the second tool unreachable with no trace; record it where
				// the connection summary reports it.
				failures.push({
					server: connection.server,
					error: `tool "${tool.name}" skipped: its registered name "${name}" is already taken by another tool`,
				});
				continue;
			}
			registered.set(name, { server: connection.server.name, tool: tool.name });

			const def: ToolDefinition = {
				name,
				label: `${connection.server.name}: ${tool.name}`,
				...ccToolRenderers(`${connection.server.name}: ${tool.name}`),
				description: capDescription(tool.description) ?? `MCP tool "${tool.name}" from server "${connection.server.name}".`,
				parameters: jsonSchemaToTypeBox(tool.inputSchema),
				async execute(toolCallId, params, signal, _onUpdate, ctx) {
					const live = connections.get(connection.server.name);
					if (!live) {
						return {
							content: [{ type: "text", text: `MCP server "${connection.server.name}" is not connected.` }],
							details: {} as Record<string, unknown>,
							isError: true,
						};
					}
					const current = live.tools.find((candidate) => candidate.name === tool.name);
					if (!current || !isDeepStrictEqual(current.inputSchema, tool.inputSchema)) {
						return {
							content: [{ type: "text", text: !current
								? `MCP server "${connection.server.name}" no longer exposes tool "${tool.name}".`
								: `MCP tool "${name}" changed its input schema. Run /reload to load the new definition; this call was not sent.` }],
							details: {} as Record<string, unknown>,
							isError: true,
						};
					}
					try {
						const result = await callTool(live, tool.name, (params ?? {}) as Record<string, unknown>, signal);
						const { text: contentText, images } = describeContent(result.content as McpContentBlock[] | undefined, connection.server.name);
						const structuredText = result.structuredContent !== undefined ? JSON.stringify(result.structuredContent, null, 2) : "";
						const text = [contentText, structuredText].filter(Boolean).join("\n");
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
	// False after session_shutdown: every pi.* call throws from then on (lib/session-lifecycle.ts).
	const alive = sessionAlive(pi);

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
		// A server that dies (or drops the HTTP session) mid-session must not keep
		// reading "connected" with a stale tool count; its tools stay registered
		// and answer "not connected" until Reconnect in /mcp.
		connection.client.onclose = () => {
			if (connection.closing || !alive()) return;
			if (connections.get(server.name) !== connection) return;
			connections.delete(server.name);
			const tail = connection.stderrTail();
			failures.push({
				server,
				error: `connection closed by the server${tail ? `\nserver stderr: ${tail.slice(-1_000)}` : ""}`,
			});
			emitInstructions();
		};
		let previousTools = connection.tools;
		connection.onToolsChanged = (error) => {
			if (!alive() || connection.closing || connections.get(server.name) !== connection) return;
			if (error) {
				failures.push({ server, error: error.message });
				pi.events.emit(REMINDER_CHANNEL, { text: `MCP server "${server.name}" could not refresh its tool list: ${error.message}` });
				return;
			}
			const unavailable = previousTools.filter((old) => {
				const current = connection.tools.find((tool) => tool.name === old.name);
				return !current || !isDeepStrictEqual(current.inputSchema, old.inputSchema);
			});
			previousTools = connection.tools;
			registerToolsFor(connection);
			if (unavailable.length > 0) {
				pi.events.emit(REMINDER_CHANNEL, {
					text: `MCP server "${server.name}" removed or changed these tools: ${unavailable.map((tool) => namespacedToolName(server.name, tool.name)).join(", ")}. Their old definitions cannot be used. Run /reload to refresh changed schemas.`,
				});
			}
		};
		registerToolsFor(connection);
		for (const warning of connection.warnings) failures.push({ server, error: warning });
		if (connection.resources.length > 0 || connection.resourceTemplates?.length) registerResourceTools();
	};

	const connectOne = async (server: McpServer): Promise<void> => {
		failures = failures.filter((f) => f.server.name !== server.name);
		oauthNeeded.delete(server.name);
		const provider = server.kind === "http" && hasStoredTokens(server) ? silentProvider(server) : undefined;
		try {
			const connection = await connect(server, provider);
			if (!alive()) {
				await close(connection);
				return;
			}
			adoptConnection(server, connection);
		} catch (error) {
			if (!alive()) return;
			if (server.kind === "http" && isUnauthorized(error)) oauthNeeded.add(server.name);
			else failures.push({ server, error: (error as Error).message });
		}
	};

	/**
	 * Tell the MODEL about the servers, the way Claude Code does (findings §14):
	 * each connected server's own usage instructions (its initialize result), and
	 * which servers failed — otherwise it concludes the tools do not exist or the
	 * user has no access instead of reporting a connection failure the user can
	 * fix (review M4). Re-run on every connect, close, reconnect, authenticate,
	 * enable and disable. Before the first request the two first-prepend blocks on
	 * message 1 are (re)written; after it they are frozen and only the changes are
	 * announced (./announce.ts).
	 */
	const publishBaseline = (value: McpAnnounced) => {
		pi.events.emit(CONTEXT_BASELINE_CHANNEL, { key: "mcp", value: serializeMcpAnnounced(value) });
	};
	const emitInstructions = () => {
		const live = [...connections.values()];
		const snapshot: McpSnapshot = {
			connected: live.map((c) => ({ name: c.server.name, instructions: c.instructions })),
			failed: failures.filter((f) => !connections.has(f.server.name)).map((f) => ({ name: f.server.name, error: f.error })),
		};

		if (!requestSent) {
			// Nothing is cached yet: (re)write the standing message-1 blocks.
			const nextAnnounced = announcedFrom(snapshot);
			publishBaseline(nextAnnounced);
			if (snapshot.failed.length === 0) {
				pi.events.emit(REMINDER_CHANNEL, { scope: "every-turn", key: "mcp-failures", text: "", remove: true });
			} else {
				pi.events.emit(REMINDER_CHANNEL, {
					scope: "every-turn",
					key: "mcp-failures",
					text: mcpFailuresReminder(snapshot.failed),
					placement: "first-prepend",
					order: CONTEXT_ORDER.mcp + 1,
				});
			}
			const instructions = mcpInstructionsReminder(live);
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
			announced = nextAnnounced;
			return;
		}

		// Message 1 is frozen (rewriting it would re-cache the whole conversation):
		// tell the model only what changed, as one-shots where it reads next.
		const delta = mcpDelta(announced, snapshot);
		const notices = mcpChangeNotices(delta);
		if (notices.length > 0) {
			const nextAnnounced = { instructed: new Map(announced.instructed), failed: new Map(announced.failed) };
			applyMcpDelta(nextAnnounced, delta);
			publishBaseline(nextAnnounced);
		}
		for (const text of notices) pi.events.emit(REMINDER_CHANNEL, { text });
		applyMcpDelta(announced, delta);
	};

	/** Config files that exist but failed to parse (review M11) — shown at startup and in /mcp. */
	let configErrors: string[] = [];

	/** How the consent check asks, tells and records a "No", for startup and for Reconnect alike. */
	const consentDeps = (ctx: ExtensionContext): McpTrustDeps => ({
		hasUI: ctx.hasUI,
		select: (title, options) => consentDialog(pi.events, (signal) => ctx.ui.select(title, options, { signal })),
		notify: (message) => {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		},
		disable: (server) => {
			setMcpServerDisabled(server.name, true, "project", ctx.cwd, home);
			disabledNames.add(server.name);
		},
	});

	const connectAll = async (ctx: ExtensionContext) => {
		const plugins = discoverPlugins(defaultDiscoverRoots(getAgentDir(), ctx.cwd));
		pluginConfigPaths = new Set(plugins.mcpConfigs);
		configErrors = [];
		const configNotes: string[] = [];
		servers = loadServers(ctx.cwd, home, process.env, [...pluginConfigPaths], {
			pluginNames: plugins.mcpConfigPlugins,
			onError: (path, message) => configErrors.push(`${path}: ${message}`),
			piConfigs: piMcpConfigs(ctx.cwd),
			onNote: (message) => configNotes.push(message),
			registered: registeredMcpServers(pi),
		});
		// An older snapshot stored only the rendered blocks: read them again by the
		// configured names, before any delta is taken against them.
		if (legacyBlocks) {
			announced = mcpAnnouncedFromReminders(legacyBlocks.instructions, legacyBlocks.failures, servers.map((server) => server.name));
			legacyBlocks = undefined;
		}
		const configWarnings = [
			...(configErrors.length > 0 ? [`MCP config could not be parsed (ignored): ${configErrors.join("; ")}`] : []),
			...configNotes,
		];
		for (const text of configWarnings) {
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			else process.stderr.write(`${text}\n`);
		}
		disabledNames = readDisabledMcpServers(ctx.cwd, home);
		// A resumed first-prepend may describe a server whose configuration was
		// removed entirely. There is no connection attempt in that case, so make
		// the frozen-prefix delta explicit rather than leaving the stale capability
		// silently standing. Fresh empty sessions keep their byte-identical no-op.
		if (servers.length === 0) {
			if (requestSent) emitInstructions();
			return;
		}

		// Disabled servers are listed but never connected; a server with an unset
		// credential env var stays "needs authentication" and is not attempted
		// (connecting with an empty token fails confusingly). A project .mcp.json
		// server needs the user's consent first (trust.ts — a cloned repo must not
		// run commands at startup). Everything else connects.
		const candidates = servers.filter((server) => !disabledNames.has(server.name) && !server.missingEnv?.length);
		// Reserve the modal position before the asynchronous policy read, so the
		// external-includes dialog cannot jump ahead of MCP's startup consent.
		const consent = await consentDialog(pi.events, (signal) => approveMcpServers(candidates, pluginConfigPaths, ctx.cwd, home, {
			...consentDeps(ctx),
			select: (title, options) => ctx.ui.select(title, options, { signal }),
		}));
		if (!consent || !alive()) return;
		withheldNames.clear();
		for (const { server, reason } of consent.withheld) {
			withheldNames.set(
				server.name,
				reason === "disabled-by-claude-settings"
					? "disabled by disabledMcpjsonServers in Claude Code settings"
					: reason === "declined"
						? "not approved this session (project .mcp.json)"
						: "not approved (project .mcp.json; approve in an interactive session)",
			);
		}
		await Promise.all(consent.approved.map(connectOne));

		if (!alive()) return;

		// Warnings from servers that did connect are shown in /mcp, not as failures.
		const failed = failures.filter((f) => !connections.has(f.server.name));
		if (ctx.hasUI) {
			// Needs auth: an OAuth sign-in, or a credential variable that is not set (never attempted).
			const needsAuth = new Set([...oauthNeeded, ...servers.filter((server) => !disabledNames.has(server.name) && server.missingEnv?.length).map((server) => server.name)]).size;
			for (const text of mcpStartupNotices(new Set(failed.map((f) => f.server.name)).size, needsAuth)) ctx.ui.notify(text, "warning");
		} else if (failed.length > 0) {
			// Headless runs have no /mcp, so they keep each server's error on stderr.
			process.stderr.write(`${failed.map((f) => `MCP server "${f.server.name}" failed: ${f.error}`).join("\n")}\n`);
		}

		emitInstructions();
	};

	let resourceToolsRegistered = false;
	const registerResourceTools = () => {
		if (resourceToolsRegistered) return;
		resourceToolsRegistered = true;

		const registerResourceTool: ExtensionAPI["registerTool"] = (definition) => {
			pi.registerTool(definition);
			sharedTools.push(definition as ToolDefinition);
		};

		registerResourceTool({
			name: "list_mcp_resources",
			label: "MCP Resources",
			...ccToolRenderers("MCP Resources"),
			description:
				"List resources and URI templates exposed by connected MCP servers. Resources are readable documents or data the server offers, addressed by uri. Substitute template variables to construct a resource uri.",
			parameters: Type.Object({
				server: Type.Optional(Type.String({ description: "Limit to one server by name" })),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
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
					for (const template of connection.resourceTemplates ?? []) {
						lines.push(`${connection.server.name} ${template.uriTemplate} (URI template)${template.name ? ` — ${template.name}` : ""}${template.description ? `: ${template.description}` : ""}`);
					}
				}
				return {
					content: [
						{
							type: "text",
							text: lines.length ? persistIfLarge(lines.join("\n"), { dir: resultsDir(ctx), id: toolCallId }) : "No MCP resources available.",
						},
					],
					details: { count: lines.length },
				};
			},
		});

		registerResourceTool({
			name: "read_mcp_resource",
			label: "Read MCP Resource",
			...ccToolRenderers("Read MCP Resource"),
			description: "Read one resource from an MCP server by uri. Use list_mcp_resources to find uris.",
			parameters: Type.Object({
				server: Type.String({ description: "Server name that owns the resource" }),
				uri: Type.String({ description: "Resource uri" }),
			}),
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const connection = connections.get(params.server);
				if (!connection) return unknownServerError(params.server);
				try {
					const result = await readResource(connection, params.uri, signal);
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

		registerResourceTool({
			name: "read_mcp_resource_dir",
			label: "List MCP Resource Directory",
			...ccToolRenderers("List MCP Resource Directory"),
			description:
				'List the direct children of a directory resource on an MCP server (resources/directory/read). Not recursive: each entry carries its own uri, and subdirectories appear with mimeType "inode/directory" — call again on a subdirectory uri to descend. Only servers that support directory listing accept this; others return an error.',
			parameters: Type.Object({
				server: Type.String({ description: "Server name that owns the directory" }),
				uri: Type.String({ description: "The directory resource uri to list" }),
			}),
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const connection = connections.get(params.server);
				if (!connection) return unknownServerError(params.server);
				try {
					const result = await readResourceDir(connection, params.uri, signal);
					const entries = (result.resources ?? result.entries ?? []) as Array<{ uri?: string; name?: string; mimeType?: string }>;
					const lines = entries.map((e) => `${e.uri ?? "(no uri)"}${e.name ? ` — ${e.name}` : ""}${e.mimeType ? ` (${e.mimeType})` : ""}`);
					return {
						content: [
							{
								type: "text",
								text: lines.length ? persistIfLarge(lines.join("\n"), { dir: resultsDir(ctx), id: toolCallId }) : "(empty directory)",
							},
						],
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
		pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [...sharedTools] });
	};

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoredContext(pi.events);
		// The restored stack owns message 1. Its structured state records the exact
		// arbitrary server text that was shown; a fresh session keeps prior behavior.
		requestSent = restored !== undefined;
		const stackText = (key: string) => restored?.stack.find((entry) => (entry as { key?: string }).key === key)?.text;
		const structured = mcpAnnouncedBaseline(restored?.baselines.mcp);
		legacyBlocks = structured ? undefined : { instructions: stackText("mcp-instructions"), failures: stackText("mcp-failures") };
		announced = structured ?? mcpAnnouncedFromReminders(legacyBlocks?.instructions, legacyBlocks?.failures);
		if (!restored) publishBaseline(announced);
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
		// The external-includes question follows the startup hooks/MCP consent,
		// but does not wait for slow server connections.
		startupConsentReady(pi.events);
		connecting.finally(() => {
			connectSettled = true;
			// The session may be gone by now (/clear while a remote server was still
			// answering): pi's API throws from assertActive after session_shutdown,
			// and from a promise continuation that is an uncaught exception that
			// killed the process (STEERING-REVIEW-2026-09-05 H3, measured).
			if (!alive()) return;
			// Final publish, marked settled — emitted even with zero servers/tools so
			// a consumer that spawns children early (subagents) can stop waiting for
			// late-connecting servers instead of snapshotting an empty set forever.
			pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [...sharedTools], settled: true });
		});
		if (!ctx.hasUI) {
			await connecting;
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.all([...connections.values()].map((connection) => close(connection)));
		connections.clear();
	});

	// Single source of truth for a server's status, shared by the /plugins status
	// snapshot, the /mcp panel entries, and the text fallback.
	const deriveStatus = (server: McpServer): { status: McpEntryStatus; detail?: string; toolCount?: number } => {
		if (disabledNames.has(server.name)) return { status: "disabled" };
		const withheld = withheldNames.get(server.name);
		if (withheld) return { status: "disabled", detail: withheld };
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
		if (server.source === claudeJsonPath(home) || server.piOrigin === "user") {
			return { rank: 0, group: `User MCPs (${shorten(server.source)})`, configLocation: shorten(server.source), scope: "user" };
		}
		if (server.source.endsWith(join(".claude", "settings.local.json"))) {
			return { rank: 2, group: "Project MCPs (.claude/settings.local.json)", configLocation: shorten(server.source), scope: "project" };
		}
		if (server.piOrigin === "extension") {
			return { rank: 3, group: "Extension MCPs", configLocation: shorten(server.source), scope: "user" };
		}
		if (server.piOrigin === "project") {
			return { rank: 1, group: `Project MCPs (${join(CONFIG_DIR_NAME, "mcp.json")})`, configLocation: shorten(server.source), scope: "project" };
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
					status === "failed" || status === "connected" || status === "disabled" || (status === "authNeeded" && !canAuthenticate)
						? detail
						: undefined;
				// Auth line shown on a failed http server (as Claude Code does), read
				// honestly from whether tokens are stored — not just "failed http".
				const authState =
					status === "failed" && server.kind === "http"
						? hasStoredTokens(server)
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
				const refusal = reconnectRefusal(server);
				if (refusal) {
					notices = [refusal];
					syncRepaint();
					return;
				}
				busy.add(entry.name);
				// Reconnect spawns the command again, so a project server needs the
				// same consent startup asked for (a stored or session approval
				// passes without a prompt).
				const consent = await approveMcpServers([server], pluginConfigPaths, ctx.cwd, home, consentDeps(ctx));
				if (consent.approved.length === 0) {
					busy.delete(entry.name);
					if (!alive()) return;
					notices = [`"${entry.name}" was not approved, so it was not reconnected.`];
					syncRepaint();
					return;
				}
				notices = [`Reconnecting to "${entry.name}"…`];
				syncRepaint();
				const existing = connections.get(entry.name);
				if (existing) {
					connections.delete(entry.name);
					await close(existing);
				}
				await connectOne(server);
				busy.delete(entry.name);
				// The session may have been replaced during the connect (an RPC
				// new_session while the panel was open): every pi.* call throws
				// then, and from a void'ed continuation that is an unhandled
				// rejection (LIFECYCLE-REVIEW-2026-09-06 L2).
				if (!alive()) return;
				emitInstructions();
				notices = outcomeNotice(server);
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
				// Enabling a withheld project .mcp.json server by hand IS the consent.
				if (withheldNames.delete(entry.name)) persistApproval(projectRootOf(server), server);
				busy.add(entry.name);
				notices = [`Enabling "${entry.name}"…`];
				syncRepaint();
				await connectOne(server);
				busy.delete(entry.name);
				if (!alive()) return; // see runReconnect
				emitInstructions();
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
					if (!alive()) {
						await close(connection); // see runReconnect
						return;
					}
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

			// Each action is a void'ed promise. A throw after the session was
			// replaced is expected (every pi.* call throws then) and dropped; any
			// other failure is shown in the panel, never an unhandled rejection.
			const guarded = (work: Promise<void>) =>
				work.catch((error) => {
					if (!alive()) return;
					notices = [`Action failed: ${(error as Error).message}`];
					syncRepaint();
				});

			const runEffect = (effect: McpEffect) => {
				switch (effect.kind) {
					case "close":
						clearInterval(ticker);
						done(null);
						return;
					case "reconnect":
						void guarded(runReconnect(effect.entry));
						return;
					case "disable":
						runDisable(effect.entry);
						return;
					case "enable":
						void guarded(runEnable(effect.entry));
						return;
					case "authenticate":
						void guarded(runAuthenticate(effect.entry));
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

	registerLocalCommand(pi, "mcp", {
		description: "Manage MCP servers (status, reconnect, authenticate, enable/disable)",
		handler: async (args, ctx) => {
			if (servers.length === 0) {
				ctx.ui.notify(
					claudeSourcesOn() ? "No MCP servers configured. Add them to .mcp.json or ~/.claude.json." : "No MCP servers configured. Add them to .pi/mcp.json or the agent dir's mcp.json.",
					"info",
				);
				return;
			}
			if (canShowCustomUi(ctx)) {
				await openMcpPanel(ctx);
				return;
			}
			notifyRpcReadOnly(ctx, "/mcp", "reconnect, authenticate, enable or disable servers");
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
