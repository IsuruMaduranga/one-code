import { describe, expect, it } from "vitest";
import { supportsToolReferences, withDeferredToolDefinitions } from "../../extensions/lib/deferred.ts";

describe("supportsToolReferences", () => {
	it("mirrors pi's rule: first-party Claude 4.5+, never Haiku", () => {
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-sonnet-5" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-opus-4-5-20251101" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-fable-5-1" })).toBe(true);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-opus-4-1" })).toBe(false);
		expect(supportsToolReferences({ provider: "anthropic", id: "claude-haiku-4-5" })).toBe(false);
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

describe("withDeferredToolDefinitions", () => {
	it("appends every missing deferred tool as defer_loading, sorted by name, in pi's schema shape", () => {
		const payload = {
			model: "claude-sonnet-5",
			tools: [{ name: "read", input_schema: {} }, { name: "tool_search", input_schema: {}, cache_control: { type: "ephemeral" } }],
			messages: [],
		};
		const out = withDeferredToolDefinitions(payload, registry, deferred)!;
		expect(out).toBeDefined();
		const tools = out.tools as Array<Record<string, unknown>>;
		expect(tools.slice(0, 2)).toEqual(payload.tools);
		expect(tools.slice(2)).toEqual([
			{
				name: "lsp_diagnostics",
				description: "Diagnostics",
				input_schema: { type: "object", properties: { path: { type: "string" } }, required: [] },
				defer_loading: true,
			},
			{ name: "mcp__s__t", description: "", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true },
			{
				name: "web_fetch",
				description: "Fetch",
				input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
				defer_loading: true,
			},
		]);
		// Never mutates the input.
		expect(payload.tools).toHaveLength(2);
	});

	it("skips tools pi already sent (a loaded deferred tool) and leaves a complete payload alone", () => {
		const payload = {
			tools: [
				{ name: "read", input_schema: {} },
				{ name: "tool_search", input_schema: {} },
				{ name: "web_fetch", input_schema: {}, defer_loading: true },
			],
			messages: [],
		};
		const out = withDeferredToolDefinitions(payload, registry, deferred)!;
		const names = (out.tools as Array<{ name: string }>).map((t) => t.name);
		expect(names).toEqual(["read", "tool_search", "web_fetch", "lsp_diagnostics", "mcp__s__t"]);
		expect(withDeferredToolDefinitions(out, registry, deferred)).toBeUndefined();
	});

	it("does nothing without a tools array or when the wire names are not the registry's (stealth renames)", () => {
		expect(withDeferredToolDefinitions({ messages: [] }, registry, deferred)).toBeUndefined();
		expect(withDeferredToolDefinitions({ tools: [], messages: [] }, registry, deferred)).toBeUndefined();
		expect(withDeferredToolDefinitions({ tools: [{ name: "Read" }, { name: "ToolSearch" }], messages: [] }, registry, deferred)).toBeUndefined();
	});
});
