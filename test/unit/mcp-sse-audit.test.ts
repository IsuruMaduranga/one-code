import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginInteractiveAuth, callTool, close, connect, finishInteractiveAuth, isUnauthorized, type Connection } from "../../extensions/mcp/client.ts";
import { parseServer, type HttpServer } from "../../extensions/mcp/config.ts";
import { McpOAuthProvider } from "../../extensions/mcp/oauth/provider.ts";
import { silentProvider } from "../../extensions/mcp/oauth/flow.ts";
import { hashServerConfig } from "../../extensions/mcp/trust.ts";

let endpoint: Server | undefined;
let connection: Connection | undefined;
let stream: ServerResponse | undefined;
let requests: Array<{ method?: string; path?: string; authorization?: string }> = [];
let home: string;
let grants: string[] = [];

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mcp-sse-audit-")); });
afterEach(async () => {
	if (connection) await close(connection);
	connection = undefined;
	stream?.end();
	stream = undefined;
	endpoint?.closeAllConnections();
	if (endpoint) await new Promise<void>((resolve) => endpoint!.close(() => resolve()));
	endpoint = undefined;
	requests = [];
	grants = [];
	rmSync(home, { recursive: true, force: true });
});

async function serveLegacy(authenticate: (request: IncomingMessage) => boolean = () => true, withOAuth = false) {
	endpoint = createServer(async (request, response) => {
		requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
		if (withOAuth && request.url === "/token") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			grants.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("grant_type") ?? "");
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fresh-token", token_type: "bearer" }));
			return;
		}
		if (!authenticate(request)) {
			response.writeHead(401).end("Authentication required");
			return;
		}
		if (request.method === "GET" && request.url === "/sse") {
			stream = response;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write("event: endpoint\ndata: /messages\n\n");
			return;
		}
		if (request.method !== "POST" || request.url !== "/messages" || !stream) {
			response.writeHead(405).end("Use GET /sse for the legacy transport");
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string };
		response.writeHead(202).end();
		if (message.id === undefined) return;
		const result = message.method === "initialize"
			? { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "legacy-sse", version: "1" } }
			: message.method === "tools/list"
				? { tools: [{ name: "hello", inputSchema: { type: "object" } }] }
				: message.method === "resources/list"
					? { resources: [] }
					: message.method === "resources/templates/list"
						? { resourceTemplates: [] }
						: { content: [{ type: "text", text: "hello from legacy SSE" }] };
		stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
	});
	await new Promise<void>((resolve) => endpoint!.listen(0, "127.0.0.1", resolve));
	const address = endpoint.address();
	if (!address || typeof address === "string") throw new Error("missing local test endpoint");
	return `http://127.0.0.1:${address.port}/sse`;
}

function oauthProvider(server: HttpServer, openAuthorization?: (url: URL) => void) {
	const provider = new McpOAuthProvider({ server, home, env: {}, redirectUrl: "http://127.0.0.1:5000/callback", openAuthorization });
	const origin = new URL(server.url).origin;
	provider.saveClientInformation({ client_id: "test-client" });
	provider.saveDiscoveryState({
		authorizationServerUrl: origin,
		resourceMetadata: { resource: server.url, authorization_servers: [origin] },
		authorizationServerMetadata: { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] },
	});
	return provider;
}

describe("explicit legacy SSE MCP transport", () => {
	it("refreshes an expired OAuth token silently before reopening the event stream", async () => {
		const url = await serveLegacy((request) => request.headers.authorization === "Bearer fresh-token", true);
		const server = parseServer("legacy", { type: "sse", url }, "test", {}) as HttpServer;
		oauthProvider(server).saveTokens({ access_token: "expired-token", refresh_token: "refresh-token", token_type: "bearer" });
		const provider = silentProvider(server, home, {});
		connection = await connect(server, provider);
		expect(connection.tools.map((tool) => tool.name)).toEqual(["hello"]);
		expect(grants).toEqual(["refresh_token"]);
		expect(provider.tokens()).toMatchObject({ access_token: "fresh-token", refresh_token: "refresh-token" });
		expect(requests.some((request) => request.method === "GET" && request.authorization === "Bearer fresh-token")).toBe(true);
	});

	it("finishes interactive OAuth for the legacy transport and reconnects with the issued token", async () => {
		const url = await serveLegacy((request) => request.headers.authorization === "Bearer fresh-token", true);
		const server = parseServer("legacy", { type: "sse", url }, "test", {}) as HttpServer;
		const openAuthorization = vi.fn();
		const provider = oauthProvider(server, openAuthorization);
		const started = await beginInteractiveAuth(server, provider);
		if (!("transport" in started)) throw new Error("expected authorization redirect");
		try {
			expect(openAuthorization).toHaveBeenCalledOnce();
			await finishInteractiveAuth(started.transport, "test-code");
		} finally {
			await started.transport.close();
		}
		connection = await connect(server, silentProvider(server, home, {}));
		expect(connection.tools.map((tool) => tool.name)).toEqual(["hello"]);
		expect(grants).toEqual(["authorization_code"]);
	});

	it("preserves an explicit type:sse in parsed configuration", () => {
		expect(parseServer("legacy", { type: "sse", url: "https://example.test/sse" }, "test", {})).toMatchObject({ kind: "http", transport: "sse" });
	});

	it("connects, lists and calls tools using the legacy endpoint with configured headers on GET and POST", async () => {
		const url = await serveLegacy((request) => request.headers.authorization === "Bearer fixture-token");
		const server = parseServer("legacy", { type: "sse", url, headers: { Authorization: "Bearer fixture-token" } }, "test", {});
		if (!server) throw new Error("configuration rejected");
		connection = await connect(server);
		expect(connection.tools.map((tool) => tool.name)).toEqual(["hello"]);
		await expect(callTool(connection, "hello", {})).resolves.toMatchObject({ content: [{ type: "text", text: "hello from legacy SSE" }] });
		expect(requests[0]).toEqual({ method: "GET", path: "/sse", authorization: "Bearer fixture-token" });
		expect(requests.some((request) => request.method === "POST" && request.path === "/messages")).toBe(true);
		expect(requests.every((request) => request.authorization === "Bearer fixture-token")).toBe(true);
	});

	it("requires fresh consent when a remote config changes between Streamable HTTP and legacy SSE", () => {
		const http = parseServer("remote", { type: "http", url: "https://example.test/mcp" }, "test", {})!;
		const sse = parseServer("remote", { type: "sse", url: "https://example.test/mcp" }, "test", {})!;
		expect(hashServerConfig(sse)).not.toBe(hashServerConfig(http));
	});

	it("keeps the existing Streamable HTTP configuration and approval hash unchanged", () => {
		const implicit = parseServer("remote", { url: "https://example.test/mcp" }, "test", {})!;
		const explicit = parseServer("remote", { type: "http", url: "https://example.test/mcp" }, "test", {})!;
		expect(explicit).toEqual(implicit);
		expect(explicit).not.toHaveProperty("transport");
		expect(hashServerConfig(explicit)).toBe(hashServerConfig({ kind: "http", name: "remote", url: "https://example.test/mcp", source: "test" }));
	});

	it("classifies an unauthorized legacy SSE endpoint as needing authentication", async () => {
		const url = await serveLegacy(() => false);
		const server = parseServer("legacy", { type: "sse", url }, "test", {})!;
		const error = await connect(server).catch((error: unknown) => error);
		expect(isUnauthorized(error)).toBe(true);
	});
});
