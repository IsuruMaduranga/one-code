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
 * register anything) and closed on `session_shutdown`.
 */

import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { callTool, close, type Connection, connect, type FailedConnection, readResource } from "./client.ts";
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

export default function mcpExtension(pi: ExtensionAPI) {
	const connections = new Map<string, Connection>();
	const failures: FailedConnection[] = [];
	const registered = new Set<string>();
	let servers: McpServer[] = [];

	const registerToolsFor = (connection: Connection) => {
		for (const tool of connection.tools) {
			const name = namespacedToolName(connection.server.name, tool.name);
			if (registered.has(name)) continue;
			registered.add(name);

			pi.registerTool({
				name,
				label: `${connection.server.name}: ${tool.name}`,
				description: tool.description ?? `MCP tool "${tool.name}" from server "${connection.server.name}".`,
				parameters: jsonSchemaToTypeBox(tool.inputSchema),
				async execute(_toolCallId, params) {
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
								{ type: "text", text: text || "(no output)" },
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
			});

			// Deferred: the model discovers these through tool_search.
			pi.events.emit(DEFER_CHANNEL, {
				name,
				keywords: [connection.server.name, tool.name.replace(/[_-]/g, " "), "mcp"],
			});
		}
	};

	const connectAll = async (ctx: ExtensionContext) => {
		servers = loadServers(ctx.cwd, os.homedir(), process.env, discoverPlugins(join(os.homedir(), ".claude")).mcpConfigs);
		if (servers.length === 0) return;

		const results = await Promise.all(
			servers.map(async (server) => {
				try {
					return { connection: await connect(server) };
				} catch (error) {
					return { failure: { server, error: (error as Error).message } };
				}
			}),
		);

		for (const result of results) {
			if (result.connection) {
				connections.set(result.connection.server.name, result.connection);
				registerToolsFor(result.connection);
			} else if (result.failure) {
				failures.push(result.failure);
			}
		}

		if (failures.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				failures.map((f) => `MCP server "${f.server.name}" failed: ${f.error}`).join("\n"),
				"warning",
			);
		}

		const resourceCount = [...connections.values()].reduce((n, c) => n + c.resources.length, 0);
		if (resourceCount > 0) {
			registerResourceTools();
		}
	};

	let resourceToolsRegistered = false;
	const registerResourceTools = () => {
		if (resourceToolsRegistered) return;
		resourceToolsRegistered = true;

		pi.registerTool({
			name: "list_mcp_resources",
			label: "MCP Resources",
			description:
				"List resources exposed by connected MCP servers. Resources are readable documents or data the server offers, addressed by uri.",
			parameters: Type.Object({
				server: Type.Optional(Type.String({ description: "Limit to one server by name" })),
			}),
			async execute(_toolCallId, params) {
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
			description: "Read one resource from an MCP server by uri. Use list_mcp_resources to find uris.",
			parameters: Type.Object({
				server: Type.String({ description: "Server name that owns the resource" }),
				uri: Type.String({ description: "Resource uri" }),
			}),
			async execute(_toolCallId, params) {
				const connection = connections.get(params.server);
				if (!connection) {
					return {
						content: [{ type: "text", text: `No connected MCP server named "${params.server}".` }],
						details: {} as { server?: string; uri?: string },
						isError: true,
					};
				}
				try {
					const result = await readResource(connection, params.uri);
					const text = describeResourceContents(result.contents as McpResourceContents[] | undefined);
					return {
						content: [{ type: "text", text: text || "(empty resource)" }],
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

		for (const name of ["list_mcp_resources", "read_mcp_resource"]) {
			pi.events.emit(DEFER_CHANNEL, { name, keywords: ["mcp", "resource", "document", "uri"] });
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await connectAll(ctx);
	});

	pi.on("session_shutdown", async () => {
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
					return `connected ${server.name} — ${connection.tools.length} tools, ${connection.resources.length} resources (${server.source})`;
				}
				const failure = failures.find((f) => f.server.name === server.name);
				return `failed    ${server.name} — ${failure?.error ?? "not connected"} (${server.source})`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
