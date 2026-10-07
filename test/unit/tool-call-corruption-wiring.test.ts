import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import toolCallCorruptionExtension from "../../extensions/tool-call-corruption/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const model = { provider: "openrouter", id: "z-ai/glm-5.3", baseUrl: "https://openrouter.ai/api/v1" };
const corrupt = '{"command":"grep -rn \\\"","run_in_background":false}';

describe("OpenRouter tool-call corruption wiring", () => {
	let fake: FakePi;
	let ctx: ReturnType<typeof createFakeCtx> & { ui: { notify: ReturnType<typeof vi.fn> } };
	let fetchMock: ReturnType<typeof vi.fn>;
	let getAuth: ReturnType<typeof vi.fn>;
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.useFakeTimers();
		fake = createFakePi();
		getAuth = vi.fn(async () => ({ ok: true, apiKey: "session-key" }));
		ctx = createFakeCtx({ model, mode: "tui", hasUI: true, modelRegistry: { getApiKeyAndHeaders: getAuth } }) as typeof ctx;
		fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { provider_name: "Morph" } }) }));
		vi.stubGlobal("fetch", fetchMock);
		stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		toolCallCorruptionExtension(fake.pi as never);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("agent_start", {}, ctx);
	});

	afterEach(async () => {
		await fake.fire("session_shutdown", {}, ctx);
		await vi.runAllTimersAsync();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function stream(raw = corrupt, tool = "bash", id = "bad", index = 0, responseId: string | undefined = "gen-123") {
		const partial = { role: "assistant", responseId, content: [] };
		const update = (event: object) => fake.fire("message_update", { message: partial, assistantMessageEvent: { ...event, partial } }, ctx);
		await update({ type: "toolcall_start", contentIndex: index });
		for (const delta of [raw.slice(0, 7), raw.slice(7, 18), raw.slice(18)]) {
			await update({ type: "toolcall_delta", contentIndex: index, delta });
		}
		await update({ type: "toolcall_end", contentIndex: index, toolCall: { type: "toolCall", name: tool, id, arguments: {} } });
	}

	const call = (id = "bad", toolName = "bash") => fake.fireOne("tool_call", { toolCallId: id, toolName, input: {} }, ctx);
	const end = (id = "bad", toolName = "bash") => fake.fire("tool_execution_end", { toolCallId: id, toolName, isError: true, result: {} }, ctx);
	const flush = () => vi.advanceTimersByTimeAsync(0);

	it("blocks corrupted arguments, aborts after the blocked result, and names the provider once", async () => {
		await stream();
		expect(await call()).toMatchObject({ block: true, reason: expect.stringMatching(/OpenRouter.*double quote/) });
		expect(ctx.abort).not.toHaveBeenCalled();
		await end();
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		await call();
		await end();
		await flush();
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Morph.*corrupting tool calls.*z-ai\/glm-5.3/), "error");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('compat.openRouterRouting.ignore'), "error");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('models.json'), "error");
		expect(getAuth).toHaveBeenCalledWith(model);
		expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/generation?id=gen-123", expect.objectContaining({ headers: { Authorization: "Bearer session-key" } }));
		expect(fake.sentMessages).toEqual([]);
		expect(fake.sentUserMessages).toEqual([]);
	});

	it("detects concatenated raw JSON even when pi has parsed it as an empty object", async () => {
		await stream('{"action":"run"}{"prompt":"hello"}', "Agent");
		expect(await call("bad", "Agent")).toMatchObject({ block: true, reason: expect.stringMatching(/JSON/) });
		await end("bad", "Agent");
		expect(ctx.abort).toHaveBeenCalledTimes(1);
	});

	it("also aborts when schema validation skips tool_call", async () => {
		await stream('{}{}', "Agent");
		await end("bad", "Agent");
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		await flush();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
	});

	it.each(["anthropic", "openai", "openai-codex"])("leaves %s untouched", async (provider) => {
		ctx.model = { ...model, provider, baseUrl: "https://example.com/v1" };
		await stream();
		expect(await call()).toBeUndefined();
		await end();
		await flush();
		expect(ctx.abort).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("recognizes an OpenRouter base URL with a custom provider name", async () => {
		ctx.model = { ...model, provider: "custom-router" };
		await stream();
		expect(await call()).toMatchObject({ block: true });
	});

	it("does not mistake a hostname substring for OpenRouter", async () => {
		ctx.model = { ...model, provider: "other", baseUrl: "https://openrouter.ai.example.com/v1" };
		await stream();
		expect(await call()).toBeUndefined();
	});

	it("passes valid commands and does not infer corruption from missing arguments", async () => {
		await stream('{"command":"echo \\\"ok\\\""}');
		expect(await call()).toBeUndefined();
		await stream('{"action":"run"}', "Agent", "agent", 1);
		expect(await call("agent", "Agent")).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("tracks interleaved content indices and uses the final tool-call id", async () => {
		const partial = { role: "assistant", responseId: "gen-interleaved", content: [] };
		const update = (event: object) => fake.fire("message_update", { message: partial, assistantMessageEvent: { ...event, partial } }, ctx);
		for (const contentIndex of [1, 3]) await update({ type: "toolcall_start", contentIndex });
		await update({ type: "toolcall_delta", contentIndex: 3, delta: corrupt.slice(0, 15) });
		await update({ type: "toolcall_delta", contentIndex: 1, delta: '{"command":"pwd"}' });
		await update({ type: "toolcall_delta", contentIndex: 3, delta: corrupt.slice(15) });
		await update({ type: "toolcall_end", contentIndex: 1, toolCall: { name: "bash", id: "good" } });
		await update({ type: "toolcall_end", contentIndex: 3, toolCall: { name: "bash", id: "bad" } });
		expect(await call("good")).toBeUndefined();
		expect(await call("bad")).toMatchObject({ block: true });
	});

	it("does not blame the provider for a reply cut off at the token limit", async () => {
		await stream('{"command":"echo \\"');
		await fake.fire("message_end", { message: { role: "assistant", responseId: "gen-123", stopReason: "length", content: [{ type: "toolCall", id: "bad", name: "bash" }] } }, ctx);
		expect(await call()).toBeUndefined();
		await end();
		await flush();
		expect(ctx.abort).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps a completed corrupt call blocked when a later call hits the token limit", async () => {
		await stream(corrupt, "bash", "done", 0);
		await stream('{"command":"echo \\"', "bash", "cut", 1);
		const content = [{ type: "toolCall", id: "done", name: "bash" }, { type: "toolCall", id: "cut", name: "bash" }];
		await fake.fire("message_end", { message: { role: "assistant", responseId: "gen-123", stopReason: "length", content } }, ctx);
		expect(await call("done")).toMatchObject({ block: true, terminate: true });
		expect(await call("cut")).toBeUndefined();
	});

	it("reads a response id supplied only on message_end", async () => {
		await stream(corrupt, "bash", "bad", 0, "");
		await fake.fire("message_end", { message: { role: "assistant", responseId: "gen-final" } }, ctx);
		await call();
		await end();
		await flush();
		expect(fetchMock.mock.calls[0][0]).toContain("gen-final");
	});

	it("reports unknown upstream without lookup when the generation id is absent", async () => {
		await stream(corrupt, "bash", "bad", 0, "");
		await call();
		await end();
		await flush();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/provider.*could not.*identified/), "error");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["print", "json"])("flushes one notice before %s teardown without writing JSON stdout", async (mode) => {
		ctx.mode = mode;
		ctx.hasUI = false;
		fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 404 }));
		await stream();
		await call();
		await end();
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		let ended = false;
		const finished = fake.fire("agent_end", { messages: [] }, ctx).then(() => { ended = true; });
		await flush();
		expect(ended).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		await finished;
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Morph"));
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("does not delay interactive agent_end on the provider lookup", async () => {
		fetchMock.mockImplementation(() => new Promise(() => {}));
		await stream();
		await call();
		await end();
		await fake.fire("agent_end", { messages: [] }, ctx);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(8000);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("cancels lookup and suppresses callbacks after shutdown, even across restart", async () => {
		let resolveFetch!: (value: unknown) => void;
		fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
		await stream();
		await call();
		await end();
		await flush();
		const signal = fetchMock.mock.calls[0][1].signal;
		await fake.fire("session_shutdown", {}, ctx);
		expect(signal.aborted).toBe(true);
		await fake.fire("session_start", {}, ctx);
		resolveFetch({ ok: true, status: 200, json: async () => ({ data: { provider_name: "Morph" } }) });
		await flush();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("clears streamed calls and the notice latch for the next run", async () => {
		await stream();
		await call();
		await end();
		await flush();
		await fake.fire("agent_start", {}, ctx);
		expect(await call()).toBeUndefined();
		await stream();
		await call();
		await end();
		await flush();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
	});

	const partialOf = (responseId = "gen-123") => ({ role: "assistant", responseId, content: [] });
	const start = () => fake.fire("message_start", { message: { role: "assistant", content: [] } }, ctx);
	const update = (event: object, partial = partialOf()) =>
		fake.fire("message_update", { message: partial, assistantMessageEvent: { ...event, partial } }, ctx);

	it("stops a call whose arguments leak tool-call markup before the call ends", async () => {
		await start();
		await update({ type: "toolcall_start", contentIndex: 0 });
		await update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path": "src/a.py</arg_value></tool_call><tool_call>read<arg_key>limit' });
		expect(ctx.abort).not.toHaveBeenCalled();
		await update({ type: "toolcall_delta", contentIndex: 0, delta: "</arg_key><arg_value>null</arg_value>" });
		await update({ type: "toolcall_delta", contentIndex: 0, delta: "<arg_key>path" });
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		await update({ type: "toolcall_delta", contentIndex: 0, delta: "</arg_value><arg_key>x</arg_value><arg_key>" });
		await flush();
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Morph is corrupting tool calls.*cut off and the turn stopped.*openRouterRouting\.ignore/), "error");
	});

	it("stops a tool call that goes silent for 60 s and names the provider", async () => {
		await start();
		await update({ type: "toolcall_start", contentIndex: 0 });
		await update({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' });
		await vi.advanceTimersByTimeAsync(59_000);
		expect(ctx.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		await flush();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Morph stopped streaming for z-ai\/glm-5\.3 \(no data for 60 s\)\. The turn was stopped\./), "error");
		expect(fetchMock.mock.calls[0][0]).toContain("gen-123");
	});

	it("stops any stream silent for 90 s, and each event restarts the clock", async () => {
		await start();
		await vi.advanceTimersByTimeAsync(80_000);
		await update({ type: "thinking_delta", contentIndex: 0, delta: "hmm" });
		await vi.advanceTimersByTimeAsync(80_000);
		expect(ctx.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		await flush();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no data for 90 s"), "error");
	});

	const chunk = (data: object = { id: "gen-123", choices: [] }) =>
		fake.fire("provider_stream_event", { type: "provider_stream_event", provider: "openrouter", api: "openai-completions", model: model.id, data }, ctx);

	it("keeps a stream alive on raw chunks that carry no content (reasoning details, usage, empty deltas)", async () => {
		await start();
		await update({ type: "text_delta", contentIndex: 0, delta: "Let me think." });
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(80_000);
			await chunk({ id: "gen-123", choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] } }] });
		}
		expect(ctx.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
	});

	it("waits five minutes for the first content after the headers, then 90 s between chunks", async () => {
		await start();
		await chunk({ id: "gen-123", choices: [{ delta: { role: "assistant", content: "" } }] });
		await vi.advanceTimersByTimeAsync(299_000);
		expect(ctx.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		await flush();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no data for 300 s"), "error");
	});

	it("returns to the general window once a tool call's arguments end", async () => {
		await start();
		await update({ type: "toolcall_start", contentIndex: 0 });
		await update({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' });
		await update({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", name: "bash", id: "ok", arguments: {} } });
		await vi.advanceTimersByTimeAsync(89_000);
		expect(ctx.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
	});

	it("keeps the tool-call window while another call is still streaming", async () => {
		await start();
		for (const contentIndex of [0, 1]) await update({ type: "toolcall_start", contentIndex });
		await update({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' });
		await update({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", name: "bash", id: "ok", arguments: {} } });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
	});

	it("ignores raw chunks outside an assistant message", async () => {
		await chunk();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(ctx.abort).not.toHaveBeenCalled();
	});

	it("disarms the clock at message_end, between messages, and after the run", async () => {
		await start();
		await update({ type: "toolcall_start", contentIndex: 0 });
		await fake.fire("message_end", { message: { role: "assistant", responseId: "gen-123", stopReason: "toolUse" } }, ctx);
		await vi.advanceTimersByTimeAsync(600_000);
		await start();
		await fake.fire("agent_end", { messages: [] }, ctx);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(ctx.abort).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it.each(["anthropic", "openai"])("never arms the clock on %s", async (provider) => {
		ctx.model = { ...model, provider, baseUrl: "https://example.com/v1" };
		await start();
		await update({ type: "toolcall_start", contentIndex: 0 });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(ctx.abort).not.toHaveBeenCalled();
	});

	it("names the provider from the stream's chunks without a lookup", async () => {
		await start();
		await fake.fire("provider_stream_event", { type: "provider_stream_event", provider: "openrouter", api: "openai-completions", model: model.id, data: { id: "gen-123", provider: "Novita" } }, ctx);
		await update({ type: "toolcall_start", contentIndex: 0 });
		await vi.advanceTimersByTimeAsync(60_000);
		await flush();
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/provider Novita stopped streaming.*"ignore": \["Novita"\]/), "error");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("blocks a bash command cut off before its quoted argument", async () => {
		await stream('{ "command": "grep -rn "\t, "timeout": 120000 }');
		expect(await call()).toMatchObject({ block: true, reason: expect.stringMatching(/single space/) });
	});

	it("registers before hooks and permissions without adding prompt/context handlers", () => {
		const extensions: string[] = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).pi.extensions;
		const index = extensions.indexOf("extensions/tool-call-corruption/index.ts");
		expect(index).toBeGreaterThanOrEqual(0);
		expect(index).toBeLessThan(extensions.indexOf("extensions/hooks/index.ts"));
		expect(index).toBeLessThan(extensions.indexOf("extensions/permissions/index.ts"));
		for (const hook of ["context", "before_agent_start", "before_provider_request"]) expect(fake.handlers.has(hook)).toBe(false);
	});
});
