import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, close, type Connection } from "../../extensions/mcp/client.ts";
import mcpExtension from "../../extensions/mcp/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const state = vi.hoisted(() => ({ home: "", servers: [] as Array<{ kind: "http"; name: string; url: string; source: string }> }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.home, default: { ...actualDefault, homedir: () => state.home } };
});
vi.mock("../../extensions/mcp/config.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../../extensions/mcp/config.ts")>(),
	loadServers: () => state.servers,
}));

type Request = { id?: string | number; method: string; params?: { cursor?: string } };
let endpoint: Server;
let connection: Connection | undefined;
let directory: string;
let requests: Request[];
let notifications: ServerResponse | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "mcp-discovery-audit-"));
	state.home = directory;
	state.servers = [];
	requests = [];
	notifications = undefined;
});
afterEach(async () => {
	if (connection) await close(connection);
	connection = undefined;
	endpoint?.closeAllConnections();
	if (endpoint) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
	rmSync(directory, { recursive: true, force: true });
});

async function serve(resultFor: (request: Request) => unknown, withNotifications = false) {
	endpoint = createServer(async (request, response) => {
		if (request.method === "GET" && withNotifications) {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.flushHeaders();
			notifications = response;
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
		requests.push(message);
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const result = message.method === "initialize"
			? { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: withNotifications }, resources: {} }, serverInfo: { name: "discovery-audit", version: "1" } }
			: await resultFor(message);
		response.writeHead(200, { "content-type": "application/json", ...(withNotifications ? { "mcp-session-id": "audit-session" } : {}) });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const address = endpoint.address();
	if (!address || typeof address === "string") throw new Error("missing test endpoint");
	const server = { kind: "http" as const, name: "discovery", url: `http://127.0.0.1:${address.port}/mcp`, source: "test" };
	state.servers = [server];
	return server;
}

const template = { uriTemplate: "notes://{id}", name: "Note by identifier", description: "Read a note by its identifier." };

describe("MCP discovery with real HTTP transport", () => {
	it("does not cancel successfully completed discovery requests", async () => {
		const server = await serve(({ method }) => {
			if (method === "tools/list") return { tools: [] };
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [] };
		});
		connection = await connect(server);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(requests.filter((request) => request.method === "notifications/cancelled")).toEqual([]);
	});

	it("refreshes a server's tools after its list_changed notification", async () => {
		let round = 0;
		const server = await serve(({ method }) => {
			if (method === "tools/list") return { tools: [{ name: ++round === 1 ? "first_tool" : "late_tool", inputSchema: { type: "object" } }] };
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [] };
		}, true);
		connection = await connect(server);
		const changed = vi.fn();
		connection.onToolsChanged = changed;
		await vi.waitFor(() => expect(notifications).toBeDefined());
		notifications!.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
		await vi.waitFor(() => expect(connection?.tools.map((tool) => tool.name)).toEqual(["late_tool"]), { timeout: 300 });
		expect(changed).toHaveBeenCalledOnce();
	});

	it("coalesces bursts into a serialized follow-up refresh", async () => {
		let round = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const server = await serve(async ({ method }) => {
			if (method === "tools/list") {
				const current = ++round;
				if (current === 2) await blocked;
				return { tools: [{ name: `tool_${current}`, inputSchema: { type: "object" } }] };
			}
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [] };
		}, true);
		connection = await connect(server);
		const changed = vi.fn();
		connection.onToolsChanged = changed;
		await vi.waitFor(() => expect(notifications).toBeDefined());
		const notice = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;
		notifications!.write(notice);
		await vi.waitFor(() => expect(round).toBe(2));
		notifications!.write(notice.repeat(3));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(round).toBe(2);
		release();
		await vi.waitFor(() => expect(connection?.tools[0].name).toBe("tool_3"));
		expect(round).toBe(3);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("preserves the last good list and reports a refresh error", async () => {
		let round = 0;
		const server = await serve(({ method }) => {
			if (method === "tools/list") return ++round === 1
				? { tools: [{ name: "first_tool", inputSchema: { type: "object" } }] }
				: { tools: "malformed" };
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [] };
		}, true);
		connection = await connect(server);
		const changed = vi.fn();
		connection.onToolsChanged = changed;
		await vi.waitFor(() => expect(notifications).toBeDefined());
		notifications!.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
		await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(expect.any(Error)));
		expect(connection.tools.map((tool) => tool.name)).toEqual(["first_tool"]);
		expect(connection.warnings).toContainEqual(expect.stringContaining("refreshing tools failed"));
	});

	it("does not publish an in-flight refresh after the connection closes", async () => {
		let round = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const server = await serve(async ({ method }) => {
			if (method === "tools/list") {
				if (++round > 1) await blocked;
				return { tools: [{ name: `tool_${round}`, inputSchema: { type: "object" } }] };
			}
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [] };
		}, true);
		connection = await connect(server);
		const changed = vi.fn();
		connection.onToolsChanged = changed;
		await vi.waitFor(() => expect(notifications).toBeDefined());
		notifications!.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
		await vi.waitFor(() => expect(round).toBe(2));
		await close(connection);
		release();
		expect(changed).not.toHaveBeenCalled();
		expect(connection.tools[0].name).toBe("tool_1");
	});

	it("discovers every page of tools and resources", async () => {
		const server = await serve(({ method, params }) => {
			if (method === "tools/list") return params?.cursor === "tools-2"
				? { tools: [{ name: "second_tool", inputSchema: { type: "object" } }] }
				: { tools: [{ name: "first_tool", inputSchema: { type: "object" } }], nextCursor: "tools-2" };
			if (method === "resources/list") return params?.cursor === "resources-2"
				? { resources: [{ uri: "notes://second", name: "Second" }] }
				: { resources: [{ uri: "notes://first", name: "First" }], nextCursor: "resources-2" };
			return { resourceTemplates: [] };
		});
		connection = await connect(server);
		expect.soft(connection.tools.map((tool) => tool.name)).toEqual(["first_tool", "second_tool"]);
		expect.soft(connection.resources.map((resource) => resource.uri)).toEqual(["notes://first", "notes://second"]);
		expect(requests).toContainEqual(expect.objectContaining({ method: "tools/list", params: expect.objectContaining({ cursor: "tools-2" }) }));
		expect(requests).toContainEqual(expect.objectContaining({ method: "resources/list", params: expect.objectContaining({ cursor: "resources-2" }) }));
	});

	it("discovers paginated resource templates even when no concrete resources exist", async () => {
		const server = await serve(({ method, params }) => {
			if (method === "tools/list") return { tools: [] };
			if (method === "resources/list") return { resources: [] };
			if (method === "resources/templates/list") return params?.cursor === "templates-2"
				? { resourceTemplates: [{ uriTemplate: "users://{id}", name: "User" }] }
				: { resourceTemplates: [template], nextCursor: "templates-2" };
			return {};
		});
		connection = await connect(server);
		expect(connection.resourceTemplates).toEqual([template, { uriTemplate: "users://{id}", name: "User" }]);
	});

	it("reports a repeated pagination cursor instead of hanging or silently showing a partial list", async () => {
		const server = await serve(({ method }) => {
			if (method === "tools/list") return { tools: [{ name: "tool", inputSchema: { type: "object" } }], nextCursor: "stuck" };
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [] };
		});
		connection = await connect(server);
		expect(connection.tools).toEqual([]);
		expect(connection.warnings).toContainEqual(expect.stringContaining("repeated a pagination cursor"));
		expect(requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
	});

	it("offers resource helpers for a template-only server and lists its URI template", async () => {
		await serve(({ method }) => {
			if (method === "tools/list") return { tools: [] };
			if (method === "resources/list") return { resources: [] };
			return { resourceTemplates: [template] };
		});
		const fake = createFakePi();
		mcpExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: directory, hasUI: false });
		try {
			await fake.fireOne("session_start", { reason: "startup" }, ctx);
			expect(fake.tools.has("list_mcp_resources")).toBe(true);
			expect(fake.tools.has("read_mcp_resource")).toBe(true);
			const result = await fake.tools.get("list_mcp_resources")!.execute("templates", {}, undefined, undefined, ctx) as { content: Array<{ text: string }> };
			expect(result.content[0].text).toContain("notes://{id}");
		} finally {
			await fake.fire("session_shutdown", {});
		}
	});
});
