/**
 * MCP connection management. The official SDK carries the protocol; this owns
 * lifecycle, timeouts, and failure reporting.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
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
			UnauthorizedError: typeof import("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError;
	  }>
	| undefined;

// Captured from the SDK load so isUnauthorized can do a reliable `instanceof`
// (the SDK's UnauthorizedError does not set `.name`, so a name/message check is
// unreliable — a custom-message instance would be missed).
let unauthorizedClass: typeof import("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError | undefined;

export function loadSdk() {
	sdkPromise ??= Promise.all([
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/client/stdio.js"),
		import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
		import("@modelcontextprotocol/sdk/client/auth.js"),
	]).then(([client, stdio, http, auth]) => {
		unauthorizedClass = auth.UnauthorizedError;
		return {
			Client: client.Client,
			StdioClientTransport: stdio.StdioClientTransport,
			StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
			UnauthorizedError: auth.UnauthorizedError,
		};
	});
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

/** True when the error is the SDK's "authorization required" signal (an HTTP 401). */
export function isUnauthorized(error: unknown): boolean {
	// The class is captured on the first loadSdk(); every caller runs after a
	// connect (which awaits it), so it is set. The message fallback only covers
	// the impossible pre-load case.
	if (unauthorizedClass) return error instanceof unauthorizedClass;
	return error instanceof Error && /\bunauthorized\b/i.test(error.message);
}

/** Build the transport for a server, wiring an OAuth provider for http servers. */
function buildTransport(
	server: McpServer,
	sdk: Awaited<ReturnType<typeof loadSdk>>,
	authProvider?: OAuthClientProvider,
): Transport {
	if (server.kind === "stdio") {
		return new sdk.StdioClientTransport({
			command: server.command,
			args: server.args,
			env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
			stderr: "pipe",
		});
	}
	return new sdk.StreamableHTTPClientTransport(new URL(server.url), {
		authProvider,
		requestInit: server.headers ? { headers: server.headers } : undefined,
	});
}

/** List a connected client's tools and resources into a Connection. */
async function finalizeConnection(client: Client, server: McpServer): Promise<Connection> {
	const warnings: string[] = [];

	// Each list call can take up to CONNECT_TIMEOUT_MS on a slow server; run
	// them concurrently instead of stacking their worst-case latencies.
	const [toolsResult, resourcesResult] = await Promise.allSettled([
		withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing tools of "${server.name}"`),
		withTimeout(client.listResources(), CONNECT_TIMEOUT_MS, `listing resources of "${server.name}"`),
	]);

	let tools: McpTool[] = [];
	if (toolsResult.status === "fulfilled") {
		tools = (toolsResult.value.tools ?? []) as McpTool[];
	} else {
		// A server that connects but fails listTools would otherwise register
		// zero tools with no signal anywhere — surface it as a warning.
		warnings.push(`connected, but listing tools failed: ${(toolsResult.reason as Error).message}`);
	}

	let resources: McpResource[] = [];
	if (resourcesResult.status === "fulfilled") {
		resources = (resourcesResult.value.resources ?? []) as McpResource[];
	} else {
		// Resources are optional in MCP; "method not found" is normal. Anything
		// else (a timeout, a protocol error) is worth a warning.
		const message = (resourcesResult.reason as Error).message;
		if (!/method not found|-32601/i.test(message)) {
			warnings.push(`connected, but listing resources failed: ${message}`);
		}
	}

	const instructions = client.getInstructions()?.trim() || undefined;

	return { server, client, tools, resources, instructions, warnings };
}

/**
 * Connect to a server and list its tools/resources. For an http server, an
 * `authProvider` supplies OAuth: with stored tokens the connect is silent (and
 * refreshes as needed). Without a provider, an auth-required server throws an
 * UnauthorizedError and NO browser opens — the startup path relies on this to
 * mark a server "needs authentication" without an interactive redirect.
 */
/** Load the SDK and build a client + transport pair for a server. */
async function openClient(server: McpServer, authProvider?: OAuthClientProvider): Promise<{ client: Client; transport: Transport }> {
	const sdk = await loadSdk();
	const client = new sdk.Client({ name: "one-code", version: "0.1.0" }, { capabilities: {} });
	return { client, transport: buildTransport(server, sdk, authProvider) };
}

export async function connect(server: McpServer, authProvider?: OAuthClientProvider): Promise<Connection> {
	const { client, transport } = await openClient(server, authProvider);
	await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to "${server.name}"`);
	return finalizeConnection(client, server);
}

/**
 * Start an interactive OAuth authorization for an http server. Connecting with a
 * provider that has no tokens triggers the SDK's discovery + dynamic
 * registration and calls the provider's `redirectToAuthorization` (opening the
 * browser), then throws UnauthorizedError. The returned transport carries the
 * flow state, so the caller finishes it via `transport.finishAuth(code)` once the
 * loopback catches the redirect. If the connect unexpectedly succeeds (valid
 * tokens already present), the finished Connection is returned instead.
 */
export async function beginInteractiveAuth(
	server: McpServer,
	authProvider: OAuthClientProvider,
): Promise<{ transport: StreamableHTTPClientTransport } | { connection: Connection }> {
	if (server.kind !== "http") throw new Error(`OAuth is only available for http MCP servers; "${server.name}" is stdio.`);
	const { client, transport: baseTransport } = await openClient(server, authProvider);
	const transport = baseTransport as StreamableHTTPClientTransport;
	try {
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to "${server.name}"`);
		return { connection: await finalizeConnection(client, server) };
	} catch (error) {
		if (isUnauthorized(error)) return { transport };
		throw error;
	}
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
