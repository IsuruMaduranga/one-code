/**
 * agents/subagents/fork-cache.ts: the inline extension that sends a fork's requests
 * as the parent's captured request plus the fork's tail.
 */
import { describe, expect, it } from "vitest";
import { DEFER_CHANNEL } from "../../extensions/lib/request/deferred.ts";
import { captureRequest, type RequestCapture } from "../../extensions/lib/side-calls/request-replay.ts";
import { forkCacheExtension, withParentParameters, withSavedParentTools } from "../../extensions/agents/subagents/fork-cache.ts";
import { sendToMainTool } from "../../extensions/agents/subagents/send-to-main-tool.ts";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model = { api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", id: "deepseek/deepseek-v4-flash" };

function setup(maxTokens: number) {
	const capture = captureRequest(
		model,
		{ messages: [{ role: "system", content: "parent" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read" } }], max_completion_tokens: maxTokens },
		{ role: "user", timestamp: 20 },
		"parent-session",
	) as RequestCapture;
	const fake = createFakePi();
	const deferred: string[] = [];
	fake.events.on(DEFER_CHANNEL, (data) => deferred.push((data as { name: string }).name));
	forkCacheExtension(capture)(fake.pi as never);
	const ctx = createFakeCtx({ model });
	const messages = [
		{ role: "system", content: "fork", timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 20 },
		{ role: "user", content: "fork task", timestamp: 30 },
	];
	return { fake, ctx, messages, deferred };
}

describe("forkCacheExtension", () => {
	it("splices the fork's tail onto the parent's request", async () => {
		const { fake, ctx, messages } = setup(32000);
		const shaped = await fake.fireOne<{ messages: { timestamp: number }[] }>("context_with_system", { messages }, ctx);
		expect(shaped?.messages.map((message) => message.timestamp)).toEqual([1, 30]);
		const payload = await fake.fireOne<Record<string, unknown>>(
			"before_provider_request",
			{ payload: { messages: [{ role: "system", content: "fork" }, { role: "user", content: "fork task" }], tools: [] } },
			ctx,
		);
		expect(payload?.messages).toEqual([{ role: "system", content: "parent" }, { role: "user", content: "hi" }, { role: "user", content: "fork task" }]);
	});

	it("splices a body pi-ai renders again in the same call, until the next context pass", async () => {
		const { fake, ctx, messages } = setup(32000);
		await fake.fireOne("context_with_system", { messages }, ctx);
		const body = () => ({ payload: { messages: [{ role: "system", content: "fork" }, { role: "user", content: "fork task" }], tools: [] } });
		const spliced = [{ role: "system", content: "parent" }, { role: "user", content: "hi" }, { role: "user", content: "fork task" }];
		for (let send = 0; send < 2; send++) {
			const payload = await fake.fireOne<Record<string, unknown>>("before_provider_request", body(), ctx);
			expect(payload?.messages).toEqual(spliced);
		}
		// A context pass that shapes nothing (here: no covered message) ends it.
		await fake.fireOne("context_with_system", { messages: [{ role: "user", content: "other", timestamp: 99 }] }, ctx);
		expect(await fake.fireOne("before_provider_request", body(), ctx)).toBeUndefined();
	});

	it("sends the fork whole when the tail leaves too little output room", async () => {
		const { fake, ctx, messages } = setup(1000);
		expect(await fake.fireOne("context_with_system", { messages }, ctx)).toBeUndefined();
		expect(await fake.fireOne("before_provider_request", { payload: { messages: [], tools: [] } }, ctx)).toBeUndefined();
	});

	it("sends the parent's session-affinity header so the gateway routes to the parent's host", async () => {
		const { fake, ctx } = setup(32000);
		const headers: Record<string, string> = {};
		await fake.fireOne("before_provider_headers", { headers }, ctx);
		expect(headers).toEqual({ "x-session-id": "parent-session" });
	});

	it("defers the fork's own SendMessage so tool_search can load it", () => {
		expect(setup(32000).deferred).toEqual(["SendMessage"]);
	});

	it("stubs each tool the parent declares and the fork lacks, refusing it, and keeps the parent's tools block on the wire", async () => {
		const parentTools = ["read", "ask_user_question", "yield"].map((name) => ({ type: "function", function: { name, description: `parent ${name}`, parameters: { type: "object" } } }));
		// The parent's registry: its own schemas, which the stubs take so the fork's ledger keeps the recorded declarations.
		const registry = ["read", "ask_user_question", "yield", "workflow"].map((name) => ({ name, parameters: { type: "object", properties: { [`${name}_arg`]: { type: "string" } } } }));
		const capture = captureRequest(
			model,
			{ messages: [{ role: "system", content: "parent" }, { role: "user", content: "hi" }], tools: parentTools, max_completion_tokens: 32000 },
			{ role: "user", timestamp: 20 },
			"parent-session",
		) as RequestCapture;
		const fake = createFakePi();
		(fake.pi as { registerTool(tool: unknown): void }).registerTool({ name: "read", description: "fork read", parameters: {}, execute: async () => ({ content: [] }) });
		forkCacheExtension(capture, registry)(fake.pi as never);
		const ctx = createFakeCtx({ model });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		// workflow is the parent's, but its last request did not declare it: no stub, so the wire gains nothing.
		expect([...fake.tools.keys()].sort()).toEqual(["ask_user_question", "read", "yield"]);
		expect(fake.tools.get("read")!.description).toBe("fork read");
		expect(fake.tools.get("yield")!.parameters).toBe(registry[2].parameters);

		const result = (await fake.tools.get("yield")!.execute("call_y", { anything: 1 }, undefined, undefined, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(subagentResultText().forkToolUnavailable({ tool: "yield" }));
		// A second session start registers nothing twice.
		await fake.fire("session_start", { type: "session_start", reason: "reload" }, ctx);
		expect(fake.tools.size).toBe(3);

		// The fork's own body now lists the stubs; the spliced request still carries the parent's tools as captured.
		const messages = [
			{ role: "system", content: "fork", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 20 },
			{ role: "user", content: "fork task", timestamp: 30 },
		];
		await fake.fireOne("context_with_system", { messages }, ctx);
		const forkTools = [...fake.tools.values()].map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: { type: "object" } } }));
		const payload = await fake.fireOne<Record<string, unknown>>("before_provider_request", { payload: { messages: [{ role: "system", content: "fork" }, { role: "user", content: "fork task" }], tools: forkTools } }, ctx);
		expect(payload?.tools).toEqual(parentTools);
	});

	it("maps the wire's names to the parent's registry names, so a tool sent under another spelling is never stubbed twice", async () => {
		// On the Anthropic login path pi sends some tools under Claude Code's spelling ("Read" for read).
		const capture = captureRequest(
			model,
			{ messages: [{ role: "system", content: "parent" }, { role: "user", content: "hi" }], tools: ["Read", "list_agents"].map((name) => ({ type: "function", function: { name } })), max_completion_tokens: 32000 },
			{ role: "user", timestamp: 20 },
			"parent-session",
		) as RequestCapture;
		const fake = createFakePi();
		(fake.pi as { registerTool(tool: unknown): void }).registerTool({ name: "read", description: "fork read", parameters: {}, execute: async () => ({ content: [] }) });
		forkCacheExtension(capture, [{ name: "read", parameters: {} }, { name: "list_agents", parameters: { type: "object" } }])(fake.pi as never);
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, createFakeCtx({ model }));
		expect([...fake.tools.keys()].sort()).toEqual(["list_agents", "read"]);
	});
});

describe("withParentParameters", () => {
	it("gives each of the fork's own tools the parent's parameters by name, keeping the rest of the tool", async () => {
		const sent: string[] = [];
		const own = sendToMainTool((message) => sent.push(message));
		const solo = { ...own, name: "fork_only" };
		const parent = { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"] };
		const [send, other] = withParentParameters([own, solo], [{ name: "SendMessage", parameters: parent }]);
		expect(send.parameters).toBe(parent);
		expect(other).toBe(solo);
		expect(own.parameters).not.toBe(parent);
		// execute() is the fork's own: it delivers to main and refuses any other recipient.
		await send.execute("c1", { to: "main", message: "found it" }, undefined, undefined, undefined as never);
		const wrong = (await send.execute("c2", { to: "fork-2", message: "hi" }, undefined, undefined, undefined as never)) as { isError?: boolean };
		expect(sent).toEqual(["found it"]);
		expect(wrong.isError).toBe(true);
	});
});

describe("withSavedParentTools", () => {
	it("adds the saved tools the parent no longer has, keeps the current schema where both have one, and ignores a malformed file", () => {
		const current = [{ name: "read", parameters: { now: true } }];
		const saved = [{ name: "read", parameters: { then: true } }, { name: "ask_user_question", parameters: { type: "object" } }, { parameters: {} }, null];
		expect(withSavedParentTools(current, saved)).toEqual([...current, { name: "ask_user_question", parameters: { type: "object" } }]);
		for (const bad of [undefined, {}, "x"]) expect(withSavedParentTools(current, bad)).toBe(current);
		expect(withSavedParentTools(current, [{ name: "read", parameters: {} }])).toBe(current);
	});
});
