/**
 * Distribution review 2026-09-09, H1: the compaction extension imported pi-ai's
 * deep subpaths (`api/simple-options`, `utils/estimate`), which the bundled
 * app's library loader rewrites onto a dead compat path, so the app could not
 * load the extension set. Those two helpers (and the estimator chain they need)
 * are now vendored in `extensions/lib/pi-ai-estimate.ts`.
 *
 * This test imports the REAL deep paths from node_modules and asserts the
 * vendored copies produce byte-identical numbers across a battery of inputs, so
 * a pi-ai change to either function is caught here rather than drifting
 * silently. When it fails after a pi pin bump, re-vendor from the new source.
 */
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext as realClamp } from "@earendil-works/pi-ai/api/simple-options";
import { estimateMessageTokens as realEstimate } from "@earendil-works/pi-ai/utils/estimate";
import { describe, expect, it } from "vitest";
import { clampMaxTokensToContext, estimateMessageTokens } from "../../extensions/lib/pi-ai-estimate.ts";

const model = (contextWindow: number, maxTokens = 8000) => ({ contextWindow, maxTokens }) as Model<Api>;
const usage = (over: Record<string, number> = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...over });
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string, over: Record<string, number> = {}, stopReason = "stop"): Message =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 2, usage: usage(over) }) as unknown as Message;
const toolCall = (name: string, args: unknown): Message =>
	({ role: "assistant", content: [{ type: "toolCall", name, arguments: args }], stopReason: "toolUse", timestamp: 2, usage: usage() }) as unknown as Message;
const toolResult = (text: string, extra: Record<string, unknown> = {}): Message =>
	({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }], timestamp: 3, ...extra }) as unknown as Message;
const imageResult = (): Message =>
	({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "hi" }, { type: "image", data: "…", mimeType: "image/png" }], timestamp: 3 }) as unknown as Message;
const req = (messages: Message[], systemPrompt?: string, tools?: unknown[]): Context => ({ systemPrompt, messages, tools: tools as never });

describe("estimateMessageTokens parity with pi-ai", () => {
	const messages: Message[] = [
		user("hello world"),
		user(""),
		assistant("a short reply"),
		toolCall("read", { path: "/x", nested: { a: [1, 2, 3] } }),
		toolResult("x".repeat(1234)),
		imageResult(),
	];
	for (const [i, message] of messages.entries()) {
		it(`matches for message ${i} (${message.role})`, () => {
			expect(estimateMessageTokens(message)).toBe(realEstimate(message));
		});
	}
});

describe("clampMaxTokensToContext parity with pi-ai", () => {
	const cases: Array<[string, Model<Api>, Context, number]> = [
		["empty", model(200_000), req([user("hi")]), 32_000],
		["no window", model(0), req([user("x".repeat(4 * 500_000))]), 32_000],
		["system prompt + tools", model(50_000), req([user("q"), assistant("a")], "you are helpful", [{ name: "read", description: "d", parameters: {} }]), 8_000],
		["anchored on usage", model(40_000), req([user("a"), assistant("b", { input: 7, output: 1, cacheRead: 19_094, cacheWrite: 35_162, totalTokens: 54_264 })]), 32_000],
		["aborted usage ignored", model(40_000), req([user("a"), assistant("b", { totalTokens: 54_264 }, "aborted")]), 32_000],
		["trailing after usage", model(90_000), req([user("a"), assistant("b", { totalTokens: 20_000 }), toolResult("x".repeat(4 * 5_000))]), 32_000],
		["overflowing", model(40_000), req([user("x".repeat(4 * 50_000))]), 32_000],
	];
	for (const [name, m, context, maxTokens] of cases) {
		it(`matches for ${name}`, () => {
			expect(clampMaxTokensToContext(m, context, maxTokens)).toBe(realClamp(m, context, maxTokens));
		});
	}
});
