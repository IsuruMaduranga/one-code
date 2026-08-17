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
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	mcpInstructionsReminder,
	readResource,
	readResourceDir,
} from "./client.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { join } from "node:path";
import { discoverPlugins } from "../lib/plugins.ts";
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
	const failures: FailedConnection[] = [];
	const registered = new Set<string>();
	let servers: McpServer[] = [];
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

	const connectAll = async (ctx: ExtensionContext) => {
		servers = loadServers(ctx.cwd, os.homedir(), process.env, discoverPlugins(join(os.homedir(), ".claude")).mcpConfigs);
		if (servers.length === 0) return;

		// A server whose credentials are unset would connect with an empty token and
		// fail with a confusing protocol error; skip it and say why instead.
		for (const server of servers.filter((s) => s.missingEnv?.length)) {
			failures.push({
				server,
				error: `not started — ${server.missingEnv?.join(", ")} not set in the environment`,
			});
		}

		const results = await Promise.all(
			servers
				.filter((server) => !server.missingEnv?.length)
				.map(async (server) => {
				try {
					return { connection: await connect(server) };
				} catch (error) {
					return { failure: { server, error: (error as Error).message } };
				}
			}),
		);

		// The session may have shut down while a slow server was still answering;
		// a connection landing now would leak its transport, so close it instead.
		if (shuttingDown) {
			await Promise.all(results.map((result) => (result.connection ? close(result.connection) : undefined)));
			return;
		}

		for (const result of results) {
			if (result.connection) {
				connections.set(result.connection.server.name, result.connection);
				registerToolsFor(result.connection);
				for (const warning of result.connection.warnings) {
					failures.push({ server: result.connection.server, error: warning });
				}
			} else if (result.failure) {
				failures.push(result.failure);
			}
		}

		if (failures.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				failures.map((f) => `MCP server "${f.server.name}" failed: ${f.error}`).join("\n") + " (/mcp for status)",
				"warning",
			);
		}

		const resourceCount = [...connections.values()].reduce((n, c) => n + c.resources.length, 0);
		if (resourceCount > 0) {
			registerResourceTools();
		}

		// Servers' own usage instructions (initialize result) ride an every-turn
		// reminder, as Claude Code injects them (findings §14) — without this the
		// field is silently dropped and servers can't teach the model their tools.
		const instructions = mcpInstructionsReminder([...connections.values()]);
		if (instructions) {
			pi.events.emit(REMINDER_CHANNEL, {
				scope: "every-turn",
				key: "mcp-instructions",
				text: instructions,
				placement: "first-prepend",
				order: CONTEXT_ORDER.mcp,
			});
		}
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

	pi.registerCommand("mcp", {
		description: "Show MCP server status",
		handler: async (_args, ctx) => {
			if (servers.length === 0) {
				ctx.ui.notify("No MCP servers configured. Add them to .mcp.json or ~/.claude.json.", "info");
				return;
			}
			const lines = servers.map((server) => {
				const connection = connections.get(server.name);
				if (connection) {
					const warning = connection.warnings.length ? ` — WARNING: ${connection.warnings.join("; ")}` : "";
					return `connected ${server.name} — ${connection.tools.length} tools, ${connection.resources.length} resources (${server.source})${warning}`;
				}
				const failure = failures.find((f) => f.server.name === server.name);
				if (failure) return `failed    ${server.name} — ${failure.error} (${server.source})`;
				return connectSettled
					? `failed    ${server.name} — not connected (${server.source})`
					: `…         ${server.name} — still connecting (${server.source})`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
