import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginInteractiveAuth, callTool, connect, finishInteractiveAuth, isUnauthorized, readResource, readResourceDir, type Connection } from "../../extensions/mcp/client.ts";
import { silentProvider } from "../../extensions/mcp/oauth/flow.ts";
import { McpOAuthProvider } from "../../extensions/mcp/oauth/provider.ts";

let home: string;
const server = { name: "oauth-audit", kind: "http" as const, url: "https://mcp.example.test/mcp", source: "test" };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mcp-client-audit-"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	rmSync(home, { recursive: true, force: true });
});

function savedProvider() {
	const provider = new McpOAuthProvider({ server, home, env: {}, redirectUrl: "http://127.0.0.1:5000/callback" });
	provider.saveClientInformation({ client_id: "test-client" });
	provider.saveTokens({ access_token: "expired-access", refresh_token: "refresh-token", token_type: "bearer" });
	provider.saveDiscoveryState({
		authorizationServerUrl: "https://auth.example.test",
		resourceMetadata: { resource: server.url, authorization_servers: ["https://auth.example.test"] },
		authorizationServerMetadata: {
			issuer: "https://auth.example.test",
			authorization_endpoint: "https://auth.example.test/authorize",
			token_endpoint: "https://auth.example.test/token",
			response_types_supported: ["code"],
			code_challenge_methods_supported: ["S256"],
		},
	});
	return silentProvider(server, home, {});
}

async function hangingConnection(): Promise<{ connection: Connection; messages: JSONRPCMessage[] }> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const messages: JSONRPCMessage[] = [];
	serverTransport.onmessage = (message) => {
		messages.push(message);
		if ("method" in message && message.method === "initialize" && "id" in message) {
			void serverTransport.send({
				jsonrpc: "2.0", id: message.id,
				result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "hanging", version: "1" } },
			});
		}
	};
	const client = new Client({ name: "audit", version: "1" });
	await client.connect(clientTransport);
	return { connection: { server, client, tools: [], resources: [], warnings: [], stderrTail: () => "" }, messages };
}

const operations = [
	["tools/call", (connection: Connection, signal?: AbortSignal) => callTool(connection, "hang", {}, signal)],
	["resources/read", (connection: Connection, signal?: AbortSignal) => readResource(connection, "test://hang", signal)],
	["resources/directory/read", (connection: Connection, signal?: AbortSignal) => readResourceDir(connection, "test://hang", signal)],
] as const;

describe("MCP request lifecycle regressions", () => {
	it("does not report a stdio server as connected when it exits during discovery", async () => {
		const script = `
			const { createInterface } = require('node:readline');
			createInterface({ input: process.stdin }).on('line', line => {
				const request = JSON.parse(line);
				if (request.method === 'initialize') {
					process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
						protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} },
						serverInfo: { name: 'early-exit', version: '1' }
					} }) + '\\n');
				} else if (request.method === 'tools/list') {
					process.stderr.write('exited during discovery\\n');
					process.exit(0);
				}
			});
		`;
		const result = await connect({ kind: "stdio", name: "early-exit", command: process.execPath, args: ["-e", script], source: "test" }).catch((error: unknown) => error);
		if (!(result instanceof Error)) await (result as Connection).client.close();
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("closed");
		expect((result as Error).message).toContain("exited during discovery");
	});

	it.each(operations)("cancels a hanging %s request when the caller aborts", async (method, invoke) => {
		const { connection, messages } = await hangingConnection();
		vi.useFakeTimers();
		const controller = new AbortController();
		let settled = false;
		const pending = invoke(connection, controller.signal).catch(() => { settled = true; });
		try {
			controller.abort(new Error("user stopped the tool"));
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			const request = messages.find((message) => "method" in message && message.method === method);
			expect(messages).toContainEqual(expect.objectContaining({ method: "notifications/cancelled", params: expect.objectContaining({ requestId: request && "id" in request ? request.id : undefined }) }));
		} finally {
			await connection.client.close();
			await pending;
		}
	});

	it.each(operations)("gives %s the configured 120-second timeout rather than the SDK's 60 seconds", async (_method, invoke) => {
		const { connection, messages } = await hangingConnection();
		vi.useFakeTimers();
		let settled = false;
		const pending = invoke(connection).catch(() => { settled = true; });
		try {
			await vi.advanceTimersByTimeAsync(60_001);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(settled).toBe(true);
			expect(messages).toContainEqual(expect.objectContaining({ method: "notifications/cancelled" }));
		} finally {
			await connection.client.close();
			await pending;
		}
	});
});

describe("MCP OAuth runtime regressions", () => {
	it("does not wait for a browser redirect when the server rejects a freshly refreshed token", async () => {
		const provider = savedProvider();
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
			if (String(input) === server.url) return new Response("authentication required", { status: 401 });
			return Response.json({ access_token: "rejected-new-token", token_type: "bearer" });
		}));
		await expect(beginInteractiveAuth(server, provider)).rejects.toThrow("401");
	});

	it("can finish interactive authorization after the SDK closes the initial unauthorized connection", async () => {
		savedProvider();
		const openAuthorization = vi.fn();
		const provider = new McpOAuthProvider({ server, home, env: {}, redirectUrl: "http://127.0.0.1:5001/callback", openAuthorization });
		provider.invalidateCredentials("tokens");
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			if (String(input) === server.url) return new Response("authentication required", { status: 401 });
			expect(String(input)).toBe("https://auth.example.test/token");
			expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("authorization_code");
			return Response.json({ access_token: "interactive-token", token_type: "bearer" });
		}));
		const started = await beginInteractiveAuth(server, provider);
		if (!("transport" in started)) throw new Error("expected authorization redirect");
		try {
			expect(openAuthorization).toHaveBeenCalledOnce();
			await finishInteractiveAuth(started.transport, "authorization-code");
			expect(provider.tokens()?.access_token).toBe("interactive-token");
		} finally {
			await started.transport.close();
		}
	});

	it("aborts an in-flight OAuth token request when connecting times out", async () => {
		let tokenRequestStarted!: () => void;
		const tokenStarted = new Promise<void>((resolve) => { tokenRequestStarted = resolve; });
		let tokenRequestClosed = false;
		const endpoint = createServer((request, response) => {
			if (request.url === "/token") {
				response.once("close", () => { tokenRequestClosed = true; });
				tokenRequestStarted();
				return;
			}
			response.writeHead(401).end();
		});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		try {
			const address = endpoint.address();
			if (!address || typeof address === "string") throw new Error("missing test endpoint");
			const base = `http://127.0.0.1:${address.port}`;
			const localServer = { ...server, url: `${base}/mcp` };
			const provider = new McpOAuthProvider({ server: localServer, home, env: {}, redirectUrl: "http://127.0.0.1:5000/callback" });
			provider.saveClientInformation({ client_id: "test-client" });
			provider.saveTokens({ access_token: "expired", refresh_token: "refresh", token_type: "bearer" });
			provider.saveDiscoveryState({
				authorizationServerUrl: base,
				resourceMetadata: { resource: localServer.url, authorization_servers: [base] },
				authorizationServerMetadata: { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] },
			});
			vi.useFakeTimers();
			const pending = connect(localServer, provider).catch((error: unknown) => error);
			await tokenStarted;
			await vi.advanceTimersByTimeAsync(20_001);
			expect((await pending as Error).message).toContain("timed out");
			vi.useRealTimers();
			await vi.waitFor(() => expect(tokenRequestClosed).toBe(true), { timeout: 500 });
		} finally {
			vi.useRealTimers();
			endpoint.closeAllConnections();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		}
	});

	it("refreshes stored tokens on a silent reconnect through the real SDK", async () => {
		const provider = savedProvider();
		const fetchFn = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
			expect(String(_url)).toBe("https://auth.example.test/token");
			const body = new URLSearchParams(String(options?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("refresh-token");
			return Response.json({ access_token: "new-access", token_type: "bearer" });
		});
		await expect(auth(provider, { serverUrl: server.url, fetchFn })).resolves.toBe("AUTHORIZED");
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(provider.tokens()).toMatchObject({ access_token: "new-access", refresh_token: "refresh-token" });
	});

	it("reports a revoked refresh token as needing authentication without opening a browser", async () => {
		const provider = savedProvider();
		const fetchFn = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
		const error = await auth(provider, { serverUrl: server.url, fetchFn }).catch((error: unknown) => error);
		expect(isUnauthorized(error)).toBe(true);
		expect((error as Error).message).toContain("/mcp");
		expect(provider.tokens()).toBeUndefined();
	});

	it("marks an HTTP 401 without stored credentials as needing authentication", async () => {
		const endpoint = createServer((_request, response) => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "authentication required" }));
		});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		try {
			const address = endpoint.address();
			if (!address || typeof address === "string") throw new Error("missing test endpoint");
			const error = await connect({ ...server, url: `http://127.0.0.1:${address.port}/mcp` }).catch((error: unknown) => error);
			expect(isUnauthorized(error)).toBe(true);
		} finally {
			endpoint.closeAllConnections();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		}
	});
});
