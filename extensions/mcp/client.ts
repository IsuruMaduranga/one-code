/**
 * MCP connection management. The official SDK carries the protocol; this owns
 * lifecycle, timeouts, and failure reporting.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "./config.ts";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface Connection {
	server: McpServer;
	client: Client;
	tools: McpTool[];
	resources: McpResource[];
}

export interface FailedConnection {
	server: McpServer;
	error: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export async function connect(server: McpServer): Promise<Connection> {
	const client = new Client({ name: "pincer", version: "0.1.0" }, { capabilities: {} });

	const transport =
		server.kind === "stdio"
			? new StdioClientTransport({
					command: server.command,
					args: server.args,
					env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
					stderr: "pipe",
				})
			: new StreamableHTTPClientTransport(new URL(server.url), {
					requestInit: server.headers ? { headers: server.headers } : undefined,
				});

	await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to "${server.name}"`);

	let tools: McpTool[] = [];
	try {
		const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing tools of "${server.name}"`);
		tools = (listed.tools ?? []) as McpTool[];
	} catch {
		tools = [];
	}

	let resources: McpResource[] = [];
	try {
		const listed = await withTimeout(
			client.listResources(),
			CONNECT_TIMEOUT_MS,
			`listing resources of "${server.name}"`,
		);
		resources = (listed.resources ?? []) as McpResource[];
	} catch {
		// Resources are optional in MCP; a server without them is normal.
		resources = [];
	}

	return { server, client, tools, resources };
}

export async function callTool(
	connection: Connection,
	toolName: string,
	args: Record<string, unknown>,
): Promise<{ content?: unknown[]; isError?: boolean }> {
	const result = await withTimeout(
		connection.client.callTool({ name: toolName, arguments: args }),
		CALL_TIMEOUT_MS,
		`calling "${toolName}"`,
	);
	return result as { content?: unknown[]; isError?: boolean };
}

export async function readResource(connection: Connection, uri: string): Promise<{ contents?: unknown[] }> {
	return (await withTimeout(
		connection.client.readResource({ uri }),
		CALL_TIMEOUT_MS,
		`reading resource "${uri}"`,
	)) as { contents?: unknown[] };
}

export async function close(connection: Connection): Promise<void> {
	try {
		await withTimeout(connection.client.close(), 3000, "closing connection");
	} catch {
		// A server that won't close cleanly should not block shutdown.
	}
}
