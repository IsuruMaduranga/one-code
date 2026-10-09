import { runAgentLoop, type BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import toolCallCorruptionExtension from "../../extensions/tool-call-corruption/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model: Model<"openai-completions"> = {
	id: "z-ai/glm-5.3", name: "GLM", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("corruption guard against pi's offline agent loop", () => {
	it.each([
		["parallel", "truncated"],
		["sequential", "truncated"],
		["parallel", "concatenated"],
		["sequential", "concatenated"],
		["parallel", "schema-invalid"],
		["sequential", "schema-invalid"],
	] as const)("stops %s execution on %s arguments without a retry", async (toolExecution, damage) => {
		const fake = createFakePi();
		const controller = new AbortController();
		const ctx = createFakeCtx({ model, mode: "json", signal: controller.signal, abort: vi.fn(() => controller.abort()),
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) } });
		const notice = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { provider_name: "Morph" } }) }));
		vi.stubGlobal("fetch", fetchMock);
		toolCallCorruptionExtension(fake.pi as never);
		await fake.fire("session_start", {}, ctx);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "should not execute" }], details: {} }));
		const badArgs: Record<string, string> = damage === "truncated" ? { command: 'grep -rn "' } : damage === "schema-invalid" ? {} : { command: "pwd" };
		const raw = damage === "truncated" ? JSON.stringify(badArgs) : '{"command":"pwd"}{"command":"ls"}';
		const message: AssistantMessage = {
			role: "assistant", content: [
				{ type: "toolCall", id: "bad", name: "bash", arguments: badArgs },
				{ type: "toolCall", id: "sibling", name: "bash", arguments: { command: "pwd" } },
			], api: model.api, provider: model.provider, model: model.id, responseId: "gen-test", timestamp: 1, stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const providerCall = vi.fn();
		const stream = vi.fn(() => {
			const events = createAssistantMessageEventStream();
			// Like the real provider, an already-aborted signal returns an aborted
			// stream without sending a request. Validation errors lack terminate.
			if (controller.signal.aborted) {
				events.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
				return events;
			}
			providerCall();
			if (providerCall.mock.calls.length > 1) throw new Error("The guard allowed another model request");
			events.push({ type: "start", partial: message });
			for (const [contentIndex, call] of message.content.entries()) {
				if (call.type !== "toolCall") continue;
				events.push({ type: "toolcall_start", contentIndex, partial: message });
				events.push({ type: "toolcall_delta", contentIndex, delta: contentIndex === 0 ? raw : JSON.stringify(call.arguments), partial: message });
				events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
			}
			events.push({ type: "done", reason: "toolUse", message });
			return events;
		});
		try {
			const messages = await runAgentLoop(
				[{ role: "user", content: "test", timestamp: 0 }],
				{ messages: [], tools: [{ name: "bash", label: "bash", description: "test shell", parameters: Type.Object({ command: Type.String() }), execute }] },
				{ model, toolExecution, convertToLlm: (messages) => messages as Message[],
					beforeToolCall: ({ toolCall, args }) => fake.fireOne<BeforeToolCallResult>("tool_call", { toolCallId: toolCall.id, toolName: toolCall.name, input: args }, ctx) },
				async (event) => { await fake.fire(event.type, event, ctx); },
				controller.signal, stream,
			);
			expect(controller.signal.aborted).toBe(true);
			expect(ctx.abort).toHaveBeenCalledTimes(1);
			expect(execute).not.toHaveBeenCalled();
			expect(providerCall).toHaveBeenCalledTimes(1);
			expect(stream).toHaveBeenCalledTimes(damage === "schema-invalid" ? 2 : 1);
			expect(notice).toHaveBeenCalledTimes(1);
			expect(notice).toHaveBeenCalledWith(expect.stringContaining("Morph"));
			const result = messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			if (damage !== "schema-invalid") expect(JSON.stringify(result)).toContain("OpenRouter tool-call corruption");
		} finally {
			await fake.fire("session_shutdown", {}, ctx);
		}
	});
});
