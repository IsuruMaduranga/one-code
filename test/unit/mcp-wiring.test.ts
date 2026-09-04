/**
 * mcp/index.ts wiring (M15): adoptConnection (tool registration, resource
 * tools, the onclose failure path), reconnect (through the real /mcp panel),
 * the instructions reminder add/remove, and the MCP_TOOLS_CHANNEL publish.
 *
 * The MCP SDK client is a real network/stdio protocol client, so `connect` /
 * `close` / `callTool` / `isUnauthorized` are replaced at the `./client.ts`
 * module boundary with controllable fakes; the rest of that module (schema
 * conversion, reminder formatting) is kept real via `importOriginal`.
 * `os.homedir()` is redirected to a private temp dir that holds this test's
 * own `.claude.json`, so results don't depend on the real developer machine's
 * MCP config or installed plugins.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcpClient from "../../extensions/mcp/client.ts";
import mcpExtension from "../../extensions/mcp/index.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import { MCP_STATUS_CHANNEL, MCP_STATUS_REQUEST_CHANNEL, type McpStatusEvent } from "../../extensions/lib/mcp-status.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

interface Fixture {
	tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
	resources?: Array<{ uri: string; name?: string; description?: string }>;
	instructions?: string;
	warnings?: string[];
	connectError?: Error;
}

const state = vi.hoisted(() => ({
	fakeHome: "",
	connectCalls: [] as string[],
	closeCalls: [] as string[],
	fixtures: new Map<string, Fixture>(),
	callToolResult: undefined as ((server: string, tool: string, params: unknown) => unknown) | undefined,
}));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.fakeHome, default: { ...actualDefault, homedir: () => state.fakeHome } };
});

vi.mock("../../extensions/mcp/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/mcp/client.ts")>();
	return {
		...actual,
		connect: vi.fn(async (server: { name: string }) => {
			state.connectCalls.push(server.name);
			const fixture = state.fixtures.get(server.name);
			if (fixture?.connectError) throw fixture.connectError;
			const client: { onclose?: () => void } = {};
			return {
				server,
				client,
				tools: fixture?.tools ?? [],
				resources: fixture?.resources ?? [],
				instructions: fixture?.instructions,
				warnings: fixture?.warnings ?? [],
				stderrTail: () => "some stderr output",
			};
		}),
		close: vi.fn(async (connection: { server: { name: string }; closing?: boolean }) => {
			state.closeCalls.push(connection.server.name);
			connection.closing = true;
		}),
		callTool: vi.fn(async (connection: { server: { name: string } }, toolName: string, params: unknown) => {
			return state.callToolResult?.(connection.server.name, toolName, params) ?? { content: [{ type: "text", text: "ok" }] };
		}),
		isUnauthorized: () => false,
	};
});

describe("mcp wiring", () => {
	let home: string;
	let cwd: string;
	let fake: FakePi;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "mcp-wiring-home-"));
		cwd = mkdtempSync(join(tmpdir(), "mcp-wiring-cwd-"));
		state.fakeHome = home;
		state.connectCalls = [];
		state.closeCalls = [];
		state.fixtures = new Map();
		state.callToolResult = undefined;
		fake = createFakePi();
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	const writeUserServers = (servers: Record<string, unknown>) => {
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
	};

	// User-scope servers (~/.claude.json) never need consent, so session_start
	// with hasUI:false both skips the trust dialog AND awaits the whole
	// connect (mcp/index.ts's non-UI path) — deterministic, no polling needed.
	const boot = async () => {
		mcpExtension(fake.pi as never);
		await fake.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd, hasUI: false }));
	};

	it("adoptConnection registers namespaced tools, publishes them, and files the instructions reminder", async () => {
		writeUserServers({ demo: { command: "demo-server", args: [] } });
		state.fixtures.set("demo", {
			tools: [
				{ name: "foo", description: "Does foo" },
				{ name: "bar" },
			],
			instructions: "Use foo wisely.",
		});

		const published: Array<{ tools: unknown[]; settled?: boolean }> = [];
		fake.events.on(MCP_TOOLS_CHANNEL, (data) => published.push(data as { tools: unknown[]; settled?: boolean }));
		const reminders: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data));

		await boot();

		expect(fake.tools.has("mcp__demo__foo")).toBe(true);
		expect(fake.tools.has("mcp__demo__bar")).toBe(true);
		expect(fake.tools.get("mcp__demo__foo")?.description).toBe("Does foo");

		// Published at least once with the tools, and a final settled publish.
		expect(published.some((p) => p.tools.length === 2)).toBe(true);
		expect(published.at(-1)?.settled).toBe(true);

		const instructions = reminders.find(
			(r) => (r as { key?: string }).key === "mcp-instructions" && !(r as { remove?: boolean }).remove,
		) as { text: string; placement: string; order: number } | undefined;
		expect(instructions).toBeDefined();
		expect(instructions!.text).toContain("Use foo wisely.");
		expect(instructions!.placement).toBe("first-prepend");
		expect(instructions!.order).toBe(CONTEXT_ORDER.mcp);
	});

	it("execute() on a registered MCP tool calls through the live connection", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });
		state.callToolResult = (server, tool, params) => ({
			content: [{ type: "text", text: `${server}/${tool} called with ${JSON.stringify(params)}` }],
		});
		await boot();

		const tool = fake.tools.get("mcp__demo__foo")!;
		const result = (await tool.execute("call-1", { x: 1 }, undefined, undefined, createFakeCtx({ cwd }))) as {
			content: Array<{ text: string }>;
			isError: boolean;
		};
		expect(result.isError).toBe(false);
		expect(result.content[0].text).toBe('demo/foo called with {"x":1}');
	});

	it("a dropped connection (server closes mid-session) fails the server and drops its instructions reminder", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }], instructions: "Use foo wisely." });
		const reminders: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data));
		await boot();

		let snapshot: McpStatusEvent | undefined;
		fake.events.on(MCP_STATUS_CHANNEL, (data) => (snapshot = data as McpStatusEvent));
		fake.events.emit(MCP_STATUS_REQUEST_CHANNEL, {});
		expect(snapshot?.servers.find((s) => s.name === "demo")?.status).toBe("connected");

		// Simulate the server dying: the transport's onclose fires.
		reminders.length = 0;
		const connectMock = mcpClient.connect as unknown as ReturnType<typeof vi.fn>;
		const liveConnection = await connectMock.mock.results.at(-1)!.value;
		liveConnection.client.onclose();

		fake.events.emit(MCP_STATUS_REQUEST_CHANNEL, {});
		expect(snapshot?.servers.find((s) => s.name === "demo")?.status).toBe("failed");
		expect(snapshot?.servers.find((s) => s.name === "demo")?.detail).toContain("connection closed by the server");

		// No connection left with instructions -> the every-turn reminder is removed.
		const removed = reminders.find((r) => (r as { key?: string }).key === "mcp-instructions" && (r as { remove?: boolean }).remove);
		expect(removed).toBeDefined();
	});

	it("after the first request, a dropped connection leaves message 1 alone and notifies as a one-shot", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }], instructions: "Use foo wisely." });
		const reminders: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data));
		await boot();

		// The first request goes out: message 1 (with the instructions block) is now cached.
		await fake.fire("context", { messages: [] });
		reminders.length = 0;
		const connectMock = mcpClient.connect as unknown as ReturnType<typeof vi.fn>;
		const liveConnection = await connectMock.mock.results.at(-1)!.value;
		liveConnection.client.onclose();

		// No keyed first-prepend change of any kind …
		expect(reminders.some((r) => (r as { key?: string }).key === "mcp-instructions")).toBe(false);
		expect(reminders.some((r) => (r as { key?: string }).key === "mcp-failures")).toBe(false);
		// … just an unkeyed one-shot the model reads where it is.
		const notice = reminders.find((r) => (r as { key?: string }).key === undefined) as { text: string; scope?: string } | undefined;
		expect(notice).toBeDefined();
		expect(notice!.text).toContain("demo");
		expect(notice!.text).toContain("connection closed by the server");
		expect(notice!.scope).toBeUndefined();
	});

	it("registers resource tools once a connected server exposes resources, and they read through the connection", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", {
			tools: [{ name: "foo" }],
			resources: [{ uri: "demo://readme", name: "Readme" }],
		});
		await boot();

		expect(fake.tools.has("list_mcp_resources")).toBe(true);
		expect(fake.tools.has("read_mcp_resource")).toBe(true);

		const list = (await fake.tools
			.get("list_mcp_resources")!
			.execute("c1", {}, undefined, undefined, createFakeCtx({ cwd }))) as { content: Array<{ text: string }> };
		expect(list.content[0].text).toContain("demo://readme");

		const unknown = (await fake.tools
			.get("read_mcp_resource")!
			.execute("c2", { server: "not-connected", uri: "x" }, undefined, undefined, createFakeCtx({ cwd }))) as {
			isError: boolean;
			content: Array<{ text: string }>;
		};
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toContain('No connected MCP server named "not-connected"');
	});

	it("reconnecting through the /mcp panel closes the stale connection and connects a fresh one", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });

		let component:
			| { handleInput: (data: string) => void; render: (w: number) => string[]; dispose?: () => void }
			| undefined;
		const ctx = createFakeCtx({
			cwd,
			hasUI: true,
			ui: {
				custom: vi.fn(
					(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) =>
						new Promise((resolve) => {
							const tui = { requestRender: () => {}, terminal: { rows: 40 } };
							const built = factory(tui, {}, {}, (result: unknown) => resolve(result));
							Promise.resolve(built).then((built2) => {
								component = built2 as typeof component;
							});
						}),
				),
			},
		});
		mcpExtension(fake.pi as never);
		await fake.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd, hasUI: false }));
		expect(state.connectCalls).toEqual(["demo"]);

		const mcpCommand = fake.commands.get("mcp")!;
		const panelDone = mcpCommand.handler("", ctx);
		await vi.waitFor(() => expect(component).toBeDefined());

		component!.handleInput("\r"); // open the (only) entry's detail view
		component!.handleInput("\r"); // action 0 = Reconnect
		await vi.waitFor(() => expect(state.connectCalls).toEqual(["demo", "demo"]));
		expect(state.closeCalls).toEqual(["demo"]);

		component!.handleInput("\x03"); // ctrl+c: close the panel
		await panelDone;
	});
});
