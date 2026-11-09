/**
 * MCP connection management. The official SDK carries the protocol; this owns
 * lifecycle, timeouts, and failure reporting.
 */

import { brand } from "../lib/profile/brand.mjs";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { childProcessEnv } from "../lib/app/app-launch.mjs";
import type { McpServer } from "./config.ts";
import { collectPages } from "./discovery.ts";
import { failureOf, McpFailureError, shownStderr } from "./failure.ts";
import { McpAuthenticationRequiredError } from "./oauth/provider.ts";
import type { McpFailure, McpStep, McpText } from "./text.ts";

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
			SSEClientTransport: typeof import("@modelcontextprotocol/sdk/client/sse.js").SSEClientTransport;
			UnauthorizedError: typeof import("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError;
	  }>
	| undefined;

// Captured from the SDK load so isUnauthorized can do a reliable `instanceof`
// (the SDK's UnauthorizedError does not set `.name`, so a name/message check is
// unreliable — a custom-message instance would be missed).
let unauthorizedClass: typeof import("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError | undefined;
let httpErrorClass: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPError | undefined;
let sseErrorClass: typeof import("@modelcontextprotocol/sdk/client/sse.js").SseError | undefined;

type HttpTransport = StreamableHTTPClientTransport | SSEClientTransport;

function loadSdk() {
	sdkPromise ??= Promise.all([
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/client/stdio.js"),
		import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
		import("@modelcontextprotocol/sdk/client/auth.js"),
		import("@modelcontextprotocol/sdk/client/sse.js"),
	]).then(([client, stdio, http, auth, sse]) => {
		unauthorizedClass = auth.UnauthorizedError;
		httpErrorClass = http.StreamableHTTPError;
		sseErrorClass = sse.SseError;
		return {
			Client: client.Client,
			StdioClientTransport: stdio.StdioClientTransport,
			StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
			SSEClientTransport: sse.SSEClientTransport,
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

export interface McpResourceTemplate {
	uriTemplate: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface Connection {
	server: McpServer;
	client: Client;
	tools: McpTool[];
	resources: McpResource[];
	resourceTemplates?: McpResourceTemplate[];
	/** Called after a tool-list refresh, or with its failure while the last good list stays intact. */
	onToolsChanged?: (failure?: McpFailure) => void;
	/** The server's own usage instructions from its initialize result, if any. */
	instructions?: string;
	/** Non-fatal problems after a successful connect (e.g. listTools failed). */
	warnings: McpFailure[];
	/** The last few KB the server wrote to stderr (stdio servers), for failure messages. */
	stderrTail: () => string;
	/** Set by `close()` so the transport's onclose callback can tell our close from the server's. */
	closing?: boolean;
}

const STDERR_TAIL_CAP = 8_000;

/**
 * A bounded tail of a stream's text. The SDK's `stderr: "pipe"` hands back a
 * PassThrough that nobody read: once its 16 KB buffer filled, a chatty server
 * blocked on write(2) and the connection hung until the call timeout (review
 * M2). Draining into a small ring keeps the server running and gives failure
 * messages the server's own last words.
 */
export function createTailBuffer(cap = STDERR_TAIL_CAP): { push(chunk: string | Uint8Array): void; text(): string } {
	let text = "";
	return {
		push(chunk) {
			text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			if (text.length > cap) text = text.slice(-cap);
		},
		text: () => text.trim(),
	};
}

/** `failure` with the server's stderr tail attached, when there is one and the failure can carry it. */
function withStderr(failure: McpFailure, tail: string): McpFailure {
	const stderr = shownStderr(tail);
	if (!stderr || (failure.kind !== "error" && failure.kind !== "timedOut" && failure.kind !== "closedDuringDiscovery")) return failure;
	return { ...failure, stderr };
}

export interface FailedConnection {
	server: McpServer;
	error: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, step: McpStep, server?: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new McpFailureError({ kind: "timedOut", server, step, ms })), ms);
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

/** True when the server requires authentication, including an expired stored grant. */
export function isUnauthorized(error: unknown): boolean {
	if (error instanceof McpAuthenticationRequiredError) return true;
	if (httpErrorClass && error instanceof httpErrorClass && error.code === 401) return true;
	if (sseErrorClass && error instanceof sseErrorClass && error.code === 401) return true;
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
	keepOAuthOpen?: () => boolean,
): { transport: Transport; stderrTail: () => string } {
	const tail = createTailBuffer();
	if (server.kind === "stdio") {
		const transport = new sdk.StdioClientTransport({
			command: server.command,
			args: server.args,
			// The user's own environment under the bundled app (lib/app/app-launch.mjs), then the server's.
			env: { ...(childProcessEnv(process.env) as Record<string, string>), ...(server.env ?? {}) },
			...(server.cwd ? { cwd: server.cwd } : {}),
			stderr: "pipe",
		});
		// The PassThrough exists before start(); drain it from the first byte.
		transport.stderr?.on("data", (chunk: string | Uint8Array) => tail.push(chunk));
		return { transport, stderrTail: tail.text };
	}
	const lifetime = new AbortController();
	const RemoteTransport = server.transport === "sse" ? sdk.SSEClientTransport : sdk.StreamableHTTPClientTransport;
	const transport = new RemoteTransport(new URL(server.url), {
		authProvider,
		requestInit: server.headers ? { headers: server.headers } : undefined,
		// The SDK's close signal covers MCP requests, but not the discovery and
		// token fetches it starts during OAuth. Those must stop with the client too.
		fetch: (input, init) => fetch(input, {
			...init,
			signal: init?.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal,
		}),
	});
	const closeTransport = transport.close.bind(transport);
	transport.close = async () => {
		if (!keepOAuthOpen?.()) lifetime.abort();
		await closeTransport();
	};
	return { transport, stderrTail: tail.text };
}

/** Bound the complete list, not each page, and cancel its last request on timeout. */
async function discoverPages<T>(
	fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<{ items: T[]; nextCursor?: string }>,
	step: McpStep,
	server: string,
): Promise<T[]> {
	const controller = new AbortController();
	try {
		return await withTimeout(collectPages((cursor) => fetchPage(cursor, controller.signal), controller.signal), CONNECT_TIMEOUT_MS, step, server);
	} catch (error) {
		controller.abort();
		throw error;
	}
}

/** A fresh, complete tool snapshot. */
export function discoverTools(client: Client, serverName: string): Promise<McpTool[]> {
	return discoverPages(async (cursor, signal) => {
		const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal });
		return { items: result.tools, nextCursor: result.nextCursor };
	}, "listTools", serverName);
}

/** List a connected client's tools, resources and URI templates into a Connection. */
async function finalizeConnection(client: Client, server: McpServer, stderrTail: () => string = () => ""): Promise<Connection> {
	const warnings: McpFailure[] = [];

	// Each complete list has one deadline; run them concurrently instead of
	// stacking their worst-case latencies or granting each page a fresh timeout.
	const [toolsResult, resourcesResult, templatesResult] = await Promise.allSettled([
		discoverTools(client, server.name),
		discoverPages(async (cursor, signal) => {
			const result = await client.listResources(cursor === undefined ? undefined : { cursor }, { signal });
			return { items: result.resources, nextCursor: result.nextCursor };
		}, "listResources", server.name),
		discoverPages(async (cursor, signal) => {
			const result = await client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { signal });
			return { items: result.resourceTemplates, nextCursor: result.nextCursor };
		}, "listResourceTemplates", server.name),
	]);

	let tools: McpTool[] = [];
	if (toolsResult.status === "fulfilled") {
		tools = toolsResult.value;
	} else {
		// A server that connects but fails listTools would otherwise register
		// zero tools with no signal anywhere — surface it as a warning.
		warnings.push({ kind: "listFailed", list: "tools", reason: failureOf(toolsResult.reason) });
	}

	// Resources and templates are optional in MCP; "method not found" is
	// normal. A timeout or protocol error must still surface as a warning.
	const optionalList = <T>(result: PromiseSettledResult<T[]>, list: "resources" | "resourceTemplates"): T[] => {
		if (result.status === "fulfilled") return result.value;
		const message = (result.reason as Error).message;
		if (!/method not found|-32601/i.test(message)) warnings.push({ kind: "listFailed", list, reason: failureOf(result.reason) });
		return [];
	};
	const resources = optionalList(resourcesResult, "resources");
	const resourceTemplates = optionalList(templatesResult, "resourceTemplates");
	const instructions = client.getInstructions()?.trim() || undefined;

	const connection: Connection = { server, client, tools, resources, resourceTemplates, instructions, warnings, stderrTail };
	const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
	let refreshing = false;
	let pending = false;
	client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
		if (connection.closing) return;
		pending = true;
		if (refreshing) return;
		refreshing = true;
		try {
			// A burst during an in-flight list gets one follow-up refresh, never
			// concurrent snapshots that could overwrite a newer list with an old one.
			while (pending && !connection.closing) {
				pending = false;
				let refreshed: McpTool[];
				try {
					refreshed = await discoverTools(client, server.name);
				} catch (cause) {
					if (connection.closing) return;
					const failure = failureOf(cause);
					const warning: McpFailure = { kind: "listFailed", list: "tools", refresh: true, reason: failure };
					if (!connection.warnings.some((known) => isDeepStrictEqual(known, warning))) connection.warnings.push(warning);
					connection.onToolsChanged?.(failure);
					continue;
				}
				if (connection.closing) return;
				connection.tools = refreshed;
				connection.onToolsChanged?.();
			}
		} finally {
			refreshing = false;
		}
	});
	// A server can exit after initialize but before discovery finishes. Its
	// onclose already fired, before index.ts can adopt the connection.
	if (!client.transport) throw new McpFailureError(withStderr({ kind: "closedDuringDiscovery", server: server.name }, stderrTail()));
	return connection;
}

/**
 * Connect to a server and list its tools/resources. For an http server, an
 * `authProvider` supplies OAuth: with stored tokens the connect is silent (and
 * refreshes as needed). Without a provider, an auth-required server throws an
 * UnauthorizedError and NO browser opens — the startup path relies on this to
 * mark a server "needs authentication" without an interactive redirect.
 */
/** Load the SDK and build a client + transport pair for a server. */
async function openClient(
	server: McpServer,
	authProvider?: OAuthClientProvider,
	keepOAuthOpen?: () => boolean,
): Promise<{ client: Client; transport: Transport; stderrTail: () => string }> {
	const sdk = await loadSdk();
	const client = new sdk.Client({ name: brand.idPrefix, version: "0.1.0" }, { capabilities: {} });
	return { client, ...buildTransport(server, sdk, authProvider, keepOAuthOpen) };
}

/**
 * Connect with the timeout, and on ANY failure close the transport before
 * rethrowing: a timed-out connect otherwise left the child process / HTTP
 * session alive with nobody holding it (review M5). Non-auth errors carry the
 * server's stderr tail; an UnauthorizedError is rethrown untouched so
 * `isUnauthorized` (an instanceof check) still recognises it.
 */
async function connectOrClose(
	client: Client,
	transport: Transport,
	server: McpServer,
	stderrTail: () => string,
): Promise<void> {
	try {
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect", server.name);
	} catch (error) {
		await transport.close().catch(() => {});
		if (isUnauthorized(error)) throw error;
		throw new McpFailureError(withStderr(failureOf(error), stderrTail()));
	}
}

export async function connect(server: McpServer, authProvider?: OAuthClientProvider): Promise<Connection> {
	const { client, transport, stderrTail } = await openClient(server, authProvider);
	await connectOrClose(client, transport, server, stderrTail);
	return finalizeConnection(client, server, stderrTail);
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
): Promise<{ transport: HttpTransport } | { connection: Connection }> {
	if (server.kind !== "http") throw new Error(`OAuth is only available for http MCP servers; "${server.name}" is stdio.`);
	// Client.connect closes the transport after the expected UnauthorizedError.
	// Keep OAuth fetches usable until the redirect has been handed to the caller.
	let awaitingRedirect = true;
	const { client, transport: baseTransport, stderrTail } = await openClient(server, authProvider, () => awaitingRedirect);
	const transport = baseTransport as HttpTransport;
	try {
		// Not connectOrClose: on a 401 the transport must stay open — it carries
		// the OAuth flow state the caller finishes with finishAuth(code).
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect", server.name);
		return { connection: await finalizeConnection(client, server, stderrTail) };
	} catch (error) {
		// Only the SDK's redirect signal means a browser callback is coming.
		// A raw 401 after refreshing tokens is an auth failure, not a redirect.
		if (unauthorizedClass && error instanceof unauthorizedClass) return { transport };
		awaitingRedirect = false;
		await transport.close().catch(() => {});
		throw error;
	} finally {
		awaitingRedirect = false;
	}
}

/** Bound the token exchange too; the callback deadline only covers waiting for the browser. */
export async function finishInteractiveAuth(transport: HttpTransport, code: string): Promise<void> {
	await withTimeout(transport.finishAuth(code), CONNECT_TIMEOUT_MS, "exchangeCode");
}

const INSTRUCTIONS_CAP = 3000;

/**
 * The reminder carrying servers' own usage instructions, framed by the
 * profile (One Code's is Claude Code's shape, findings §14). Servers without
 * instructions are skipped; returns undefined when none have any.
 *
 * Instructions ride message 1 (the cached prefix). Past the cap they are
 * cut with the profile's label rather than persisted to a file: the
 * label keeps it out of the "never a bare slice" rule, and a persisted path
 * would change per session and bust the cached prefix on every resume. This is
 * the deliberate documented exception to the persist rule (review L2); the cap
 * matches Claude Code's.
 */
export function mcpInstructionsReminder(
	connections: Array<{ server: { name: string }; instructions?: string }>,
	text: McpText,
): string | undefined {
	const withInstructions = connections.filter((c) => c.instructions);
	if (withInstructions.length === 0) return undefined;
	return text.instructions(withInstructions.map((c) => ({ name: c.server.name, text: shownInstructions(c.instructions!, text) })));
}

/** A server's instructions as the reminder shows them: cut at the cap, with the profile's label. */
export function shownInstructions(instructions: string, text: McpText): string {
	return instructions.length > INSTRUCTIONS_CAP ? text.instructionsCut(instructions.slice(0, INSTRUCTIONS_CAP)) : instructions;
}

/** A worded failure as the failed-servers block shows it: its first line, bounded. */
export function shownFailure(error: string): string {
	return error.split("\n")[0].slice(0, 300);
}

/**
 * Claude Code's failed-servers notice, in shape: names each server with its
 * error, then tells the model to treat it as a connection failure and the
 * quoted error as unvalidated data.
 */
export function mcpFailuresReminder(failed: Array<{ name: string; error: string }>, text: McpText): string {
	return text.failed(failed.map((f) => ({ name: f.name, error: shownFailure(f.error) })));
}

export async function callTool(
	connection: Connection,
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ content?: unknown[]; isError?: boolean; structuredContent?: Record<string, unknown> }> {
	return await connection.client.callTool({ name: toolName, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS }) as {
		content?: unknown[]; isError?: boolean; structuredContent?: Record<string, unknown>;
	};
}

export async function readResource(connection: Connection, uri: string, signal?: AbortSignal): Promise<{ contents?: unknown[] }> {
	return await connection.client.readResource({ uri }, { signal, timeout: CALL_TIMEOUT_MS });
}

/**
 * `resources/directory/read` — directory listing for resources. Not in the SDK's
 * typed surface (servers opt in), so it goes through the generic request path.
 * The SDK only calls `safeParse` on the result schema, and the response shape is
 * server-defined, so a passthrough schema beats pinning one the spec hasn't settled.
 */
export async function readResourceDir(connection: Connection, uri: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const passthrough = { safeParse: (data: unknown) => ({ success: true as const, data }) };
	return await connection.client.request(
		{ method: "resources/directory/read", params: { uri } },
		passthrough as never,
		{ signal, timeout: CALL_TIMEOUT_MS },
	) as Record<string, unknown>;
}

export async function close(connection: Connection): Promise<void> {
	connection.closing = true;
	try {
		await withTimeout(connection.client.close(), 3000, "close", connection.server.name);
	} catch {
		// A server that won't close cleanly should not block shutdown.
	}
}
