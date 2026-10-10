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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import * as mcpClient from "../../extensions/mcp/client.ts";
import mcpExtension from "../../extensions/mcp/index.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import { MCP_STATUS_CHANNEL, MCP_STATUS_REQUEST_CHANNEL, type McpStatusEvent } from "../../extensions/lib/mcp-status.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { CONTEXT_BASELINE_CHANNEL, CONTEXT_RESTORE_CHANNEL } from "../../extensions/lib/context-stack.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

interface Fixture {
	tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
	resources?: Array<{ uri: string; name?: string; description?: string }>;
	instructions?: string;
	warnings?: string[];
	connectError?: Error;
	/** Delays this server's mocked connect so startup-settle behavior is observable. */
	connectGate?: Promise<void>;
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
			await fixture?.connectGate;
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

	it("a resumed removed MCP configuration stays frozen and announces the dropped server at the tail", async () => {
		const reminders: Array<{ key?: string; text?: string }> = [];
		const baselines: unknown[] = [];
		fake.events.on(CONTEXT_RESTORE_CHANNEL, (request) => {
			(request as { restored?: unknown }).restored = {
				version: 1, stack: [], sticky: [],
				baselines: { mcp: { instructed: [["gone", "Use the old server."]], failed: [] } },
			};
		});
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { key?: string; text?: string }));
		fake.events.on(CONTEXT_BASELINE_CHANNEL, (data) => baselines.push(data));

		await boot(); // no config is deliberately written

		expect(reminders.some((r) => r.key === "mcp-instructions" || r.key === "mcp-failures")).toBe(false);
		expect(reminders.map((r) => r.text).join("\n")).toContain("gone disconnected");
		expect(baselines.at(-1)).toMatchObject({ key: "mcp", value: { instructed: [], failed: [] } });
	});

	it("does not announce a restored server as disconnected while startup connections are still settling", async () => {
		writeUserServers({ fast: { command: "fast-server" }, slow: { command: "slow-server" } });
		let releaseSlow!: () => void;
		state.fixtures.set("fast", { instructions: "Use fast." });
		state.fixtures.set("slow", {
			instructions: "Use slow.",
			connectGate: new Promise<void>((resolve) => { releaseSlow = resolve; }),
		});
		const reminders: Array<{ key?: string; text?: string }> = [];
		fake.events.on(CONTEXT_RESTORE_CHANNEL, (request) => {
			(request as { restored?: unknown }).restored = {
				version: 1, stack: [], sticky: [],
				baselines: { mcp: { instructed: [["slow", "Use slow."]], failed: [] } },
			};
		});
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { key?: string; text?: string }));
		mcpExtension(fake.pi as never);
		const starting = fake.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd, hasUI: false }));
		await vi.waitFor(() => expect(state.connectCalls).toEqual(expect.arrayContaining(["fast", "slow"])));

		// `fast` has connected but `slow` has not. A partial snapshot would report
		// the saved slow server as disconnected; no model-facing delta is emitted
		// until the Promise.all startup barrier has settled.
		expect(reminders).toEqual([]);
		releaseSlow();
		await starting;
		expect(reminders.some((r) => r.key === "mcp-instructions" || r.key === "mcp-failures")).toBe(false);
		expect(reminders.map((r) => r.text).join("\n")).not.toContain("slow disconnected");
		expect(reminders.map((r) => r.text).join("\n")).toContain("fast connected after this conversation started");
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

	it("registers changed tool lists without rewriting existing definitions or message one", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });
		const reminders: Array<{ key?: string; text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as typeof reminders[number]));
		await boot();
		await fake.fire("context", { messages: [] });
		reminders.length = 0;
		const original = fake.tools.get("mcp__demo__foo");
		const live = await vi.mocked(mcpClient.connect).mock.results.at(-1)!.value;
		live.tools = [{ name: "foo" }, { name: "late" }];
		live.onToolsChanged?.();
		expect(fake.tools.has("mcp__demo__late")).toBe(true);
		expect(fake.tools.get("mcp__demo__foo")).toBe(original);
		expect(reminders.some((notice) => notice.key)).toBe(false);
		live.tools = [{ name: "late" }];
		live.onToolsChanged?.();
		const callsBefore = vi.mocked(mcpClient.callTool).mock.calls.length;
		const result = await original!.execute("removed", {}, undefined, undefined, createFakeCtx({ cwd })) as { isError: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("no longer exposes");
		expect(vi.mocked(mcpClient.callTool).mock.calls).toHaveLength(callsBefore);
		expect(reminders.map((notice) => notice.text).join("\n")).toContain("foo");
	});

	it("refuses a changed input schema rather than executing a stale definition after reconnect", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo", inputSchema: { type: "object", properties: { old: { type: "string" } } } }] });
		await boot();
		const live = await vi.mocked(mcpClient.connect).mock.results.at(-1)!.value;
		live.tools = [{ name: "foo", inputSchema: { type: "object", properties: { new: { type: "number" } } } }];
		live.onToolsChanged?.();
		const callsBefore = vi.mocked(mcpClient.callTool).mock.calls.length;
		const result = await fake.tools.get("mcp__demo__foo")!.execute("changed", {}, undefined, undefined, createFakeCtx({ cwd })) as { isError: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("/reload");
		expect(vi.mocked(mcpClient.callTool).mock.calls).toHaveLength(callsBefore);
	});

	it("forwards tool cancellation to the MCP client", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }], resources: [{ uri: "demo://readme" }] });
		await boot();
		const signal = new AbortController().signal;
		await fake.tools.get("mcp__demo__foo")!.execute("abort-tool", {}, signal, undefined, createFakeCtx({ cwd }));
		expect(vi.mocked(mcpClient.callTool).mock.calls.at(-1)?.[3]).toBe(signal);
		const read = vi.spyOn(mcpClient, "readResource").mockResolvedValue({ contents: [] });
		const directory = vi.spyOn(mcpClient, "readResourceDir").mockResolvedValue({ entries: [] });
		try {
			await fake.tools.get("read_mcp_resource")!.execute("abort-read", { server: "demo", uri: "demo://readme" }, signal, undefined, createFakeCtx({ cwd }));
			await fake.tools.get("read_mcp_resource_dir")!.execute("abort-dir", { server: "demo", uri: "demo://" }, signal, undefined, createFakeCtx({ cwd }));
			expect(read.mock.calls[0]?.[2]).toBe(signal);
			expect(directory.mock.calls[0]?.[2]).toBe(signal);
		} finally {
			read.mockRestore();
			directory.mockRestore();
		}
	});

	it("preserves structured-only MCP results instead of reporting no output", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });
		state.callToolResult = () => ({ content: [], structuredContent: { answer: 42, records: ["important"] }, isError: true });
		await boot();
		const result = await fake.tools.get("mcp__demo__foo")!.execute("structured", {}, undefined, undefined, createFakeCtx({ cwd })) as { content: Array<{ text: string }>; isError: boolean };
		expect(JSON.parse(result.content[0].text)).toEqual({ answer: 42, records: ["important"] });
		expect(result.isError).toBe(true);
	});

	it("preserves structured data alongside text and persists the entire large result", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });
		const data = { records: "record\n".repeat(12000), final: "STRUCTURED-END" };
		state.callToolResult = () => ({ content: [{ type: "text", text: "Summary only." }], structuredContent: data });
		await boot();
		const ctx = createFakeCtx({ cwd, sessionManager: { getSessionDir: () => cwd } });
		const result = await fake.tools.get("mcp__demo__foo")!.execute("large-structured", {}, undefined, undefined, ctx) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("<persisted-output>");
		const saved = readFileSync(join(cwd, "tool-results", "large-structured.txt"), "utf8");
		expect(saved).toContain("Summary only.");
		expect(saved).toContain(JSON.stringify(data, null, 2));
	});

	it("shares resource helpers with child sessions, including servers with no tools", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { resources: [{ uri: "demo://readme" }] });
		const published: Array<{ tools: Array<{ name: string }>; settled?: boolean }> = [];
		fake.events.on(MCP_TOOLS_CHANNEL, (data) => published.push(data as typeof published[number]));
		await boot();
		expect(published.at(-1)?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
			"list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir",
		]));
	});

	it("does not defer or share an MCP definition shadowed by another extension", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });
		const original = { name: "mcp__demo__foo", execute: vi.fn(async () => ({ content: [] })) };
		fake.tools.set(original.name, original);
		fake.pi.getAllTools = () => [original];
		const deferred: unknown[] = [];
		const published: Array<{ tools: Array<{ name: string }> }> = [];
		fake.events.on("one-code:defer-tool", (data) => deferred.push(data));
		fake.events.on(MCP_TOOLS_CHANNEL, (data) => published.push(data as typeof published[number]));
		await boot();
		expect(deferred).toEqual([]);
		expect(published.at(-1)?.tools).toEqual([]);
	});

	it("registers nullable arguments and passes explicit nulls through runtime validation to the server", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", {
			tools: [{
				name: "clear",
				inputSchema: {
					type: "object",
					properties: {
						cursor: { type: ["string", "null"] },
						options: { type: ["object", "null"], properties: { enabled: { type: "boolean" } } },
						tags: { type: ["array", "null"], items: { type: "string" } },
						note: { type: ["string", "null"] },
					},
					required: ["cursor", "options", "tags"],
				},
			}],
		});
		const received: unknown[] = [];
		state.callToolResult = (_server, _tool, params) => {
			received.push(params);
			return { content: [{ type: "text", text: "cleared" }] };
		};
		await boot();

		const tool = fake.tools.get("mcp__demo__clear")!;
		const args = { cursor: null, options: null, tags: null, note: null };
		const validated = validateToolArguments(tool as Tool, { type: "toolCall", id: "clear-1", name: tool.name, arguments: args });
		expect(validated).toEqual(args);
		await tool.execute("clear-1", validated, undefined, undefined, createFakeCtx({ cwd }));
		expect(received).toEqual([args]);
		expect(() => validateToolArguments(tool as Tool, { type: "toolCall", id: "clear-2", name: tool.name, arguments: {} })).toThrow(/Validation failed/);
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

	it("RPC lists server status and names the TUI-only management limitation", async () => {
		writeUserServers({ demo: { command: "demo-server" } });
		state.fixtures.set("demo", { tools: [{ name: "foo" }] });
		await boot();
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc" });
		await fake.commands.get("mcp")!.handler("", ctx);
		expect((ctx.ui as { custom: unknown }).custom).not.toHaveBeenCalled();
		const notices = (ctx._notified as Array<{ message: string }>).map((n) => n.message).join("\n");
		expect(notices).toMatch(/RPC.*TUI/);
		expect(notices).toContain("connected");
		expect(notices).toContain("demo — 1 tools, 0 resources");
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

	/** Open /mcp with a UI whose select answers `answer`, and run the first entry's primary action. */
	const reconnectFirst = async (answer: string | undefined) => {
		let component: { handleInput: (data: string) => void; render: (w: number) => string[] } | undefined;
		const selects: string[] = [];
		const ctx = createFakeCtx({
			cwd,
			hasUI: true,
			ui: {
				select: vi.fn(async (title: string) => {
					selects.push(title);
					return answer;
				}),
				custom: vi.fn(
					(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) =>
						new Promise((resolve) => {
							const tui = { requestRender: () => {}, terminal: { rows: 40 } };
							Promise.resolve(factory(tui, {}, {}, (result: unknown) => resolve(result))).then((built) => {
								component = built as typeof component;
							});
						}),
				),
			},
		});
		const panelDone = fake.commands.get("mcp")!.handler("", ctx);
		await vi.waitFor(() => expect(component).toBeDefined());
		component!.handleInput("\r"); // detail view of the only entry
		component!.handleInput("\r"); // its primary action
		return { component: component!, selects, close: async () => { component!.handleInput("\x03"); await panelDone; } };
	};

	it("Reconnect never spawns a project server whose variable is unset, and names the variable", async () => {
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "run-it", env: { TOKEN: "$B1_UNSET_TOKEN_VAR" } } } }));
		delete process.env.B1_UNSET_TOKEN_VAR;
		await boot();
		expect(state.connectCalls).toEqual([]);
		const panel = await reconnectFirst("Use this MCP server");
		await vi.waitFor(() => expect(panel.component.render(120).join("\n")).toContain("B1_UNSET_TOKEN_VAR set in the environment"));
		expect(state.connectCalls).toEqual([]);
		expect(panel.selects).toEqual([]);
		await panel.close();
	});

	it("Reconnect asks for consent before respawning a project server, and a No keeps it off", async () => {
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { p: { command: "run-it" } } }));
		mcpExtension(fake.pi as never);
		await fake.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd, hasUI: true, ui: { select: vi.fn(async () => "Use this MCP server") } }));
		await vi.waitFor(() => expect(state.connectCalls).toEqual(["p"]));
		// The approval is gone (the store deleted, a new process): Reconnect must ask again.
		const { approvalStorePath, resetMcpTrustSessionState } = await import("../../extensions/mcp/trust.ts");
		expect(approvalStorePath().startsWith(home)).toBe(true); // never the real store
		rmSync(approvalStorePath(), { force: true });
		resetMcpTrustSessionState();
		const panel = await reconnectFirst("No");
		await vi.waitFor(() => expect(panel.selects).toHaveLength(1));
		expect(panel.selects[0]).toContain("New MCP server found in .mcp.json: p");
		await vi.waitFor(() => expect(panel.component.render(120).join("\n")).toContain("was not approved"));
		expect(state.connectCalls).toEqual(["p"]);
		await panel.close();
	});
});
