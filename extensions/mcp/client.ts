/**
 * MCP connection management. The official SDK carries the protocol; this owns
 * lifecycle, timeouts, and failure reporting.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "./config.ts";

/**
 * The MCP SDK costs ~70-80ms to load (findings §15), so it is imported on the
 * first connect rather than at startup — a session with no configured servers
 * never pays for it. The promise is cached: concurrent connects share one load.
 */
let sdkPromise:
	| Promise<{
			Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
			StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
			StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
	  }>
	| undefined;

function loadSdk() {
	sdkPromise ??= Promise.all([
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/client/stdio.js"),
		import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
	]).then(([client, stdio, http]) => ({
		Client: client.Client,
		StdioClientTransport: stdio.StdioClientTransport,
		StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
	}));
	return sdkPromise;
}

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
	/** The server's own usage instructions from its initialize result, if any. */
	instructions?: string;
	/** Non-fatal problems after a successful connect (e.g. listTools failed). */
	warnings: string[];
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
	const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await loadSdk();
	const client = new Client({ name: "one-code", version: "0.1.0" }, { capabilities: {} });

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

	const warnings: string[] = [];

	let tools: McpTool[] = [];
	try {
		const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing tools of "${server.name}"`);
		tools = (listed.tools ?? []) as McpTool[];
	} catch (error) {
		// A server that connects but fails listTools would otherwise register
		// zero tools with no signal anywhere — surface it as a warning.
		tools = [];
		warnings.push(`connected, but listing tools failed: ${(error as Error).message}`);
	}

	let resources: McpResource[] = [];
	try {
		const listed = await withTimeout(
			client.listResources(),
			CONNECT_TIMEOUT_MS,
			`listing resources of "${server.name}"`,
		);
		resources = (listed.resources ?? []) as McpResource[];
	} catch (error) {
		// Resources are optional in MCP; "method not found" is normal. Anything
		// else (a timeout, a protocol error) is worth a warning.
		resources = [];
		const message = (error as Error).message;
		if (!/method not found|-32601/i.test(message)) {
			warnings.push(`connected, but listing resources failed: ${message}`);
		}
	}

	const instructions = client.getInstructions()?.trim() || undefined;

	return { server, client, tools, resources, instructions, warnings };
}

const INSTRUCTIONS_CAP = 3000;

/**
 * The reminder carrying servers' own usage instructions, formatted the way
 * Claude Code injects them (findings §14). Servers without instructions are
 * skipped; returns undefined when none have any.
 */
export function mcpInstructionsReminder(
	connections: Array<{ server: { name: string }; instructions?: string }>,
): string | undefined {
	const withInstructions = connections.filter((c) => c.instructions);
	if (withInstructions.length === 0) return undefined;
	const sections = withInstructions.map((c) => {
		const text =
			c.instructions!.length > INSTRUCTIONS_CAP ? `${c.instructions!.slice(0, INSTRUCTIONS_CAP)}… [truncated]` : c.instructions!;
		return `## ${c.server.name}\n${text}`;
	});
	return [
		"# MCP Server Instructions",
		"",
		"The following MCP servers have provided instructions for how to use their tools and resources:",
		"",
		sections.join("\n\n"),
	].join("\n");
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

/**
 * `resources/directory/read` — directory listing for resources. Not in the SDK's
 * typed surface (servers opt in), so it goes through the generic request path.
 * The SDK only calls `safeParse` on the result schema, and the response shape is
 * server-defined, so a passthrough schema beats pinning one the spec hasn't settled.
 */
export async function readResourceDir(connection: Connection, uri: string): Promise<Record<string, unknown>> {
	const passthrough = { safeParse: (data: unknown) => ({ success: true as const, data }) };
	return (await withTimeout(
		connection.client.request({ method: "resources/directory/read", params: { uri } }, passthrough as never),
		CALL_TIMEOUT_MS,
		`listing directory "${uri}"`,
	)) as Record<string, unknown>;
}

export async function close(connection: Connection): Promise<void> {
	try {
		await withTimeout(connection.client.close(), 3000, "closing connection");
	} catch {
		// A server that won't close cleanly should not block shutdown.
	}
}
