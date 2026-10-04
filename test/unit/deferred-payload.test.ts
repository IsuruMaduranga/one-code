import { describe, expect, it } from "vitest";
import {
	stabilizeDeferredTools,
	stabilizeResponsesToolLoads,
	responsesToolLoadCompat,
	supportsToolReferences,
	toolSearchLoads,
} from "../../extensions/lib/deferred.ts";

describe("supportsToolReferences", () => {
	it("is first-party Claude 4.5+ and Haiku 4.5, not older Haikus or gateways", () => {
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-sonnet-5" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-opus-4-5-20251101" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-fable-5-1" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-opus-4-1" })).toBe(false);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-haiku-4-5" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-haiku-4-5-20251001" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-haiku-4" })).toBe(false);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-3-5-haiku" })).toBe(false);
		expect(supportsToolReferences({ provider: "openrouter", id: "anthropic/claude-haiku-4.5" })).toBe(false);
		expect(supportsToolReferences({ provider: "openrouter", id: "anthropic/claude-sonnet-5" })).toBe(false);
		expect(supportsToolReferences(undefined)).toBe(false);
	});

	it("lets the model's compat flag override the rule either way", () => {
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-haiku-4-5", compat: { supportsToolReferences: true } })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-sonnet-5", compat: { supportsToolReferences: false } })).toBe(false);
	});
});

const registry = [
	{ name: "read", description: "Read a file", parameters: { properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "tool_search", description: "Search", parameters: { properties: { query: { type: "string" } }, required: ["query"] } },
	{ name: "web_fetch", description: "Fetch", parameters: { properties: { url: { type: "string" } }, required: ["url"] } },
	{ name: "lsp_diagnostics", description: "Diagnostics", parameters: { properties: { path: { type: "string" } } } },
	{ name: "mcp__s__t", description: undefined, parameters: undefined },
];
const deferredNames = new Set(["web_fetch", "lsp_diagnostics", "mcp__s__t"]);
const deferred = (name: string) => deferredNames.has(name);

const deferredDef = (name: string) => {
	const tool = registry.find((t) => t.name === name)!;
	return {
		name,
		description: tool.description ?? "",
		input_schema: { type: "object", properties: tool.parameters?.properties ?? {}, required: tool.parameters?.required ?? [] },
		defer_loading: true,
	};
};
/** Request 1's tools on the wire after the hook: pi's eager entries, then every deferred tool sorted. */
const request1Tools = [
	{ name: "read", input_schema: {} },
	{ name: "tool_search", input_schema: {}, cache_control: { type: "ephemeral" } },
	deferredDef("lsp_diagnostics"),
	deferredDef("mcp__s__t"),
	deferredDef("web_fetch"),
];

const breakpoint = { type: "ephemeral" };
const loadMessages = (extra: unknown[] = []) => [
	{ role: "user", content: [{ type: "text", text: "hi" }] },
	{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "tool_search", input: { query: "select:web_fetch" } }] },
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Loaded web_fetch. These tools are now callable.", is_error: false, cache_control: breakpoint }],
	},
	...extra,
];

describe("stabilizeDeferredTools", () => {
	it("appends every missing deferred tool as defer_loading, sorted by name, in pi's schema shape", () => {
		const payload = { model: "claude-sonnet-5", tools: request1Tools.slice(0, 2), messages: [] };
		const out = stabilizeDeferredTools(payload, registry, deferred)!;
		expect(out).toBeDefined();
		expect(out.tools).toEqual(request1Tools);
		expect(out.messages).toBe(payload.messages);
		// Never mutates the input.
		expect(payload.tools).toHaveLength(2);
	});

	it("returns undefined without throwing when no eager registry tool remains on the wire", () => {
		// Every registry tool already carries defer_loading, and the rest are pi
		// anchors, so `eager` is empty — the final-eager-tool lookup must not deref
		// an undefined entry inside the before_provider_request hook.
		const anchor = { name: "__pi_deferred_placeholder__", input_schema: {}, defer_loading: true };
		const payload = { tools: [deferredDef("web_fetch"), deferredDef("lsp_diagnostics"), anchor], messages: [] };
		expect(() => stabilizeDeferredTools(payload, registry, deferred)).not.toThrow();
		expect(stabilizeDeferredTools(payload, registry, deferred)).toBeUndefined();
	});

	it("is idempotent: a payload already in request 1's shape comes back equal", () => {
		const payload = { tools: request1Tools, messages: [] };
		expect(stabilizeDeferredTools(payload, registry, deferred)).toEqual(payload);
	});

	it("demotes a loaded tool pi promoted to eager and references it from the tool_search result that loaded it", () => {
		// pi 0.86 (forced system prompt): the loaded tool is the last eager entry and carries the tools breakpoint.
		const payload = {
			tools: [
				{ name: "read", input_schema: {} },
				{ name: "tool_search", input_schema: {} },
				{ name: "web_fetch", input_schema: { type: "object", properties: {} }, eager_input_streaming: true, cache_control: breakpoint },
			],
			messages: loadMessages(),
		};
		const loads = new Map([["toolu_1", ["web_fetch"]]]);
		const out = stabilizeDeferredTools(payload, registry, deferred, loads)!;
		// Byte-identical to request 1: eager block, breakpoint back on the last eager tool, full deferred tail.
		expect(out.tools).toEqual(request1Tools);
		const messages = out.messages as Array<{ role: string; content: unknown[] }>;
		expect(messages.slice(0, 2)).toEqual(payload.messages.slice(0, 2));
		// The result carries only the reference; its text follows as a sibling block holding the breakpoint.
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: [{ type: "tool_reference", tool_name: "web_fetch" }] },
				{ type: "text", text: "Tool loaded.", cache_control: breakpoint },
			],
		});
		// Never mutates the input.
		expect(payload.tools[2]).toHaveProperty("cache_control");
		expect((payload.messages[2] as { content: unknown[] }).content).toHaveLength(1);
	});

	it("references the tools in the query's order and keeps a not-found note and later blocks beside them", () => {
		const payload = {
			tools: [
				{ name: "read", input_schema: {} },
				{ name: "tool_search", input_schema: {} },
				{ name: "lsp_diagnostics", input_schema: {} },
				{ name: "web_fetch", input_schema: {} },
			],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "tool_search", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Loaded web_fetch, lsp_diagnostics. These tools are now callable.\n<total_tokens>9 tokens left</total_tokens>" }] },
			],
		};
		const out = stabilizeDeferredTools(payload, registry, deferred, new Map([["toolu_1", ["web_fetch", "lsp_diagnostics"]]]))!;
		const message = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[2];
		expect(message.content[0].content).toEqual([
			{ type: "tool_reference", tool_name: "web_fetch" },
			{ type: "tool_reference", tool_name: "lsp_diagnostics" },
		]);
		expect(message.content[1]).toEqual({ type: "text", text: "Tool loaded.\n<total_tokens>9 tokens left</total_tokens>" });
		const noted = { ...payload, messages: payload.messages.map((m, i) => (i === 2 ? { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Loaded web_fetch. These tools are now callable. Not found (…): x." }] } : m)) };
		const kept = stabilizeDeferredTools(noted, registry, deferred, new Map([["toolu_1", ["web_fetch"]]]))!;
		expect((kept.messages as Array<{ content: Array<{ text?: string }> }>)[2].content[1].text).toContain("Not found");
	});

	it("keeps the rewritten result stable on later requests, where the breakpoint has moved on", () => {
		const later = loadMessages([
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "web_fetch", input: { url: "https://x" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "page", cache_control: breakpoint }] },
		]);
		delete (later[2] as { content: Array<Record<string, unknown>> }).content[0].cache_control;
		const payload = {
			tools: [{ name: "read", input_schema: {} }, { name: "tool_search", input_schema: {} }, { name: "web_fetch", input_schema: {}, cache_control: breakpoint }],
			messages: later,
		};
		const out = stabilizeDeferredTools(payload, registry, deferred, new Map([["toolu_1", ["web_fetch"]]]))!;
		expect(out.tools).toEqual(request1Tools);
		const messages = out.messages as Array<{ content: Array<Record<string, unknown>> }>;
		expect(messages[2].content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: [{ type: "tool_reference", tool_name: "web_fetch" }] },
			{ type: "text", text: "Tool loaded." },
		]);
		// The use after the load is untouched, and so is its breakpoint.
		expect(messages[4].content[0]).toHaveProperty("cache_control");
	});

	it("groups several tools loaded by one call into one result, and array result content into sibling blocks", () => {
		const payload = {
			tools: [
				{ name: "tool_search", input_schema: {} },
				{ name: "web_fetch", input_schema: {} },
				{ name: "lsp_diagnostics", input_schema: {} },
			],
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "tool_search", input: {} }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Loaded both." }, { type: "text", text: "<system-reminder>x</system-reminder>" }] },
					],
				},
			],
		};
		const out = stabilizeDeferredTools(payload, registry, deferred, new Map([["toolu_1", ["web_fetch", "lsp_diagnostics"]]]))!;
		expect((out.tools as Array<{ name: string; defer_loading?: boolean }>).map((t) => `${t.name}${t.defer_loading ? "(D)" : ""}`)).toEqual([
			"tool_search",
			"lsp_diagnostics(D)",
			"mcp__s__t(D)",
			"web_fetch(D)",
		]);
		expect((out.messages as Array<{ content: unknown[] }>)[1].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: [
					{ type: "tool_reference", tool_name: "web_fetch" },
					{ type: "tool_reference", tool_name: "lsp_diagnostics" },
				],
			},
			{ type: "text", text: "Loaded both." },
			{ type: "text", text: "<system-reminder>x</system-reminder>" },
		]);
	});

	it("keeps a loaded tool eager when its load is not on the wire or a use precedes it (the miss is accepted, never an invalid request)", () => {
		const eagerLoaded = [{ name: "tool_search", input_schema: {} }, { name: "web_fetch", input_schema: {} }];
		// Activated some other way (no tool_search load recorded): messages pass through untouched.
		const messages = loadMessages();
		const noLoad = stabilizeDeferredTools({ tools: eagerLoaded, messages }, registry, deferred)!;
		expect((noLoad.tools as Array<{ name: string; defer_loading?: boolean }>).filter((t) => !t.defer_loading).map((t) => t.name)).toEqual([
			"tool_search",
			"web_fetch",
		]);
		expect(noLoad.messages).toBe(messages);
		// The load result was compacted away: the id is known but no tool_result carries it.
		const compacted = stabilizeDeferredTools(
			{ tools: eagerLoaded, messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }] },
			registry,
			deferred,
			new Map([["toolu_1", ["web_fetch"]]]),
		)!;
		expect((compacted.tools as Array<{ name: string }>)[1].name).toBe("web_fetch");
		// Used before the load (an older session shape): a reference after the use would be rejected.
		const usedFirst = stabilizeDeferredTools(
			{
				tools: eagerLoaded,
				messages: [
					{ role: "assistant", content: [{ type: "tool_use", id: "toolu_0", name: "web_fetch", input: {} }] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "page" }] },
					...loadMessages(),
				],
			},
			registry,
			deferred,
			new Map([["toolu_1", ["web_fetch"]]]),
		)!;
		expect((usedFirst.tools as Array<{ name: string; defer_loading?: boolean }>)[1]).toMatchObject({ name: "web_fetch" });
		expect((usedFirst.tools as Array<{ defer_loading?: boolean }>)[1].defer_loading).toBeUndefined();
	});

	it("keeps pi's own deferred anchor in place and replaces pi's later-deferred rendering of a registry tool", () => {
		const anchor = { name: "__pi_deferred_placeholder__", description: "Reserved.", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true };
		const payload = {
			tools: [
				{ name: "read", input_schema: {} },
				{ name: "tool_search", input_schema: {}, cache_control: breakpoint },
				anchor,
				{ name: "web_fetch", input_schema: {}, eager_input_streaming: true, defer_loading: true },
			],
			messages: [],
		};
		const out = stabilizeDeferredTools(payload, registry, deferred)!;
		expect(out.tools).toEqual([request1Tools[0], request1Tools[1], anchor, ...request1Tools.slice(2)]);
		expect(stabilizeDeferredTools(out, registry, deferred)).toEqual(out);
	});

	it("does nothing without a tools array or when the wire names are not the registry's (stealth renames)", () => {
		expect(stabilizeDeferredTools({ messages: [] }, registry, deferred)).toBeUndefined();
		expect(stabilizeDeferredTools({ tools: [], messages: [] }, registry, deferred)).toBeUndefined();
		expect(stabilizeDeferredTools({ tools: [{ name: "Read" }, { name: "ToolSearch" }], messages: [] }, registry, deferred)).toBeUndefined();
		expect(stabilizeDeferredTools({ tools: [{ input_schema: {} }], messages: [] }, registry, deferred)).toBeUndefined();
	});
});

describe("responsesToolLoadCompat", () => {
	it("needs a Responses API and pi-ai's tool-load compat flag", () => {
		expect(responsesToolLoadCompat({ api: "openai-responses", compat: { supportsAdditionalTools: true } })).toEqual({ supportsAdditionalTools: true });
		expect(responsesToolLoadCompat({ api: "openai-codex-responses", compat: { supportsToolSearch: true } })).toEqual({ supportsToolSearch: true });
		expect(responsesToolLoadCompat({ api: "openai-responses", compat: {} })).toBeUndefined();
		expect(responsesToolLoadCompat({ api: "openai-completions", compat: { supportsAdditionalTools: true } })).toBeUndefined();
		expect(responsesToolLoadCompat(undefined)).toBeUndefined();
	});
});

describe("stabilizeResponsesToolLoads", () => {
	const fn = (name: string) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object" }, strict: false });
	const eager = [fn("read"), fn("bash"), fn("tool_search")];
	const deferred = new Set(["cron_list", "web_search"]);
	const isDeferred = (name: string) => deferred.has(name);
	const loadCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "tool_search", arguments: "{}" };
	const loadOutput = { type: "function_call_output", call_id: "call_1", output: "Loaded cron_list." };
	const payload = (input: unknown[]) => ({ model: "gpt-6.1-sol", tools: [...eager, fn("cron_list")], input: [{ role: "user", content: "go" }, ...input] });
	const loads = new Map([["call_1|fc_1", ["cron_list"]]]);

	it("moves a loaded tool from tools into an additional_tools item before the loading output", () => {
		const out = stabilizeResponsesToolLoads(payload([loadCall, loadOutput]), isDeferred, loads, { supportsAdditionalTools: true, supportsToolSearch: true });
		expect(out?.tools).toEqual(eager);
		expect(out?.input).toEqual([
			{ role: "user", content: "go" },
			loadCall,
			{ type: "additional_tools", role: "developer", tools: [fn("cron_list")] },
			loadOutput,
		]);
	});

	it("uses a tool_search_call/output pair with defer_loading when additional_tools is unsupported", () => {
		const out = stabilizeResponsesToolLoads(payload([loadCall, loadOutput]), isDeferred, loads, { supportsToolSearch: true });
		const items = out?.input as Array<Record<string, unknown>>;
		expect(items[2]).toMatchObject({ type: "tool_search_call", execution: "client", status: "completed", arguments: { query: "cron_list", limit: 1 } });
		expect(items[3]).toMatchObject({ type: "tool_search_output", call_id: items[2].call_id, tools: [{ ...fn("cron_list"), defer_loading: true }] });
		expect(items[4]).toEqual(loadOutput);
		// Deterministic, so every later request repeats the same bytes.
		expect(stabilizeResponsesToolLoads(payload([loadCall, loadOutput]), isDeferred, loads, { supportsToolSearch: true })).toEqual(out);
	});

	it("keeps the item in place as the conversation grows, and the tool usable after it", () => {
		const use = { type: "function_call", id: "fc_2", call_id: "call_2", name: "cron_list", arguments: "{}" };
		const out = stabilizeResponsesToolLoads(payload([loadCall, loadOutput, use, { type: "function_call_output", call_id: "call_2", output: "none" }]), isDeferred, loads, { supportsAdditionalTools: true });
		expect(out?.tools).toEqual(eager);
		expect((out?.input as Array<Record<string, unknown>>).map((item) => item.type ?? item.role)).toEqual(["user", "function_call", "additional_tools", "function_call_output", "function_call", "function_call_output"]);
	});

	it("leaves a tool called before its loading output, a load whose output is gone, and non-registry tools alone", () => {
		const early = { type: "function_call", id: "fc_0", call_id: "call_0", name: "cron_list", arguments: "{}" };
		expect(stabilizeResponsesToolLoads(payload([early, loadCall, loadOutput]), isDeferred, loads, { supportsAdditionalTools: true })).toBeUndefined();
		expect(stabilizeResponsesToolLoads(payload([]), isDeferred, loads, { supportsAdditionalTools: true })).toBeUndefined();
		expect(stabilizeResponsesToolLoads(payload([loadCall, loadOutput]), () => false, loads, { supportsAdditionalTools: true })).toBeUndefined();
		expect(stabilizeResponsesToolLoads(payload([loadCall, loadOutput]), isDeferred, new Map(), { supportsAdditionalTools: true })).toBeUndefined();
	});

	it("never mutates its input", () => {
		const body = payload([loadCall, loadOutput]);
		const copy = structuredClone(body);
		stabilizeResponsesToolLoads(body, isDeferred, loads, { supportsAdditionalTools: true });
		expect(body).toEqual(copy);
	});
});

describe("toolSearchLoads", () => {
	it("maps each tool_search result that activated tools to the names it loaded, skipping everything else", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "toolResult", toolName: "tool_search", toolCallId: "toolu_1", details: { added: ["web_fetch"], matches: ["web_fetch"] } } },
			{ type: "message", message: { role: "toolResult", toolName: "tool_search", toolCallId: "toolu_2", details: { added: [], matches: ["web_fetch"] } } },
			{ type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "toolu_3", details: { added: ["x"] } } },
			{ type: "message", message: { role: "toolResult", toolName: "tool_search", toolCallId: "toolu_4", details: { added: ["a", 7, "b"] } } },
			{ type: "compaction", summary: "…" },
		];
		expect([...toolSearchLoads(entries as never)]).toEqual([
			["toolu_1", ["web_fetch"]],
			["toolu_4", ["a", "b"]],
		]);
	});
});
