/**
 * Compaction review H2 (2026-09-05): an overflow-triggered compaction replayed
 * the request that had just overflowed, so pi's max_tokens clamp (or the
 * provider) returned nothing and pi's default summary served on every
 * overflow. The request shape is now decided by `replayFits`, and the
 * standalone shape is trimmed by `fitToBudget` — both asking pi-ai's own
 * `clampMaxTokensToContext`, so these tests pin the decisions against the
 * real clamp, not a copy of its arithmetic.
 */
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { describe, expect, it } from "vitest";
import {
	CLEARED_RESULT_HEAD_CHARS,
	clearToolResult,
	fitToBudget,
	MIN_REPLAY_SUMMARY_TOKENS,
	replayFits,
	STANDALONE_SUMMARY_TOKENS,
	withoutUsage,
} from "../../extensions/compaction/fit.ts";
import { STANDALONE_SYSTEM_PROMPT, standaloneRequest } from "../../extensions/compaction/index.ts";

const model = (contextWindow: number, maxTokens = 8000) => ({ contextWindow, maxTokens }) as Model<Api>;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
// Real assistant messages always carry usage (pi-ai's estimator dereferences it); zero by default.
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text = "…", usage: Record<string, unknown> = zeroUsage): Message =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2, usage }) as unknown as Message;
const toolResult = (text: string, extra: Record<string, unknown> = {}): Message =>
	({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }], timestamp: 3, ...extra }) as unknown as Message;
const request = (messages: Message[], systemPrompt = "sys"): Context => ({ systemPrompt, messages });
/** ~N tokens of text under pi's chars/4 estimate. */
const tokensOf = (n: number) => "x".repeat(n * 4);

describe("replayFits (H2)", () => {
	it("never replays on overflow: the capture is the request that just failed", () => {
		expect(replayFits("overflow", model(200_000), request([user("tiny")]), 32_000)).toBe(false);
	});

	it("replays a manual or threshold compaction that leaves the floor of output room", () => {
		// pi's default reserve (16 384) leaves ~12k after pi's own 4 096 margin.
		const nearThreshold = request([user(tokensOf(200_000 - 16_384))]);
		expect(clampMaxTokensToContext(model(200_000), nearThreshold, 32_000)).toBeGreaterThanOrEqual(MIN_REPLAY_SUMMARY_TOKENS);
		expect(replayFits("threshold", model(200_000), nearThreshold, 32_000)).toBe(true);
		expect(replayFits("manual", model(90_000), request([user(tokensOf(30_000))]), 32_000)).toBe(true);
	});

	it("falls to the standalone shape when pi's clamp would leave less than the floor", () => {
		const tooFull = request([user(tokensOf(50_000 - 4_096 - MIN_REPLAY_SUMMARY_TOKENS + 100))]);
		expect(clampMaxTokensToContext(model(50_000), tooFull, 32_000)).toBeLessThan(MIN_REPLAY_SUMMARY_TOKENS);
		expect(replayFits("manual", model(50_000), tooFull, 32_000)).toBe(false);
	});

	it("judges a captured request by its last assistant usage, as pi does", () => {
		// Small text, but the session's usage says the context is already 54k of a 40k window.
		const capture = request([user("a"), assistant("b", { input: 7, output: 1, cacheRead: 19_094, cacheWrite: 35_162, totalTokens: 54_264 })]);
		expect(replayFits("threshold", model(40_000), capture, 32_000)).toBe(false);
	});

	it("trusts the capture when the window is unknown (pi does not clamp then either)", () => {
		expect(replayFits("manual", model(0), request([user(tokensOf(500_000))]), 32_000)).toBe(true);
	});
});

describe("fitToBudget", () => {
	it("returns the request untouched when the clamp already leaves room", () => {
		const req = request([user("hi"), assistant(), toolResult("x".repeat(400))]);
		const { request: out, cleared } = fitToBudget(model(200_000), req, 32_000);
		expect(cleared).toBe(0);
		expect(out).toEqual(req);
		expect(out.messages).not.toBe(req.messages);
	});

	it("clears the largest tool results first until the clamp leaves the standalone room, keeping a landmark and a note", () => {
		const big = toolResult("B".repeat(4 * 20_000));
		const medium = toolResult("M".repeat(4 * 10_000));
		const small = toolResult("S".repeat(400));
		// 30.1k of tool results on a 40k window: 40k − 30.1k − 4 096 ≈ 5.8k < 8 192, so
		// the big one goes; then ~25k of room remain.
		const req = request([user("read them"), assistant(), big, assistant(), medium, assistant(), small, assistant("done")]);
		const { request: out, cleared } = fitToBudget(model(40_000), req, 32_000);
		expect(cleared).toBe(1);
		expect(clampMaxTokensToContext(model(40_000), out, 32_000)).toBeGreaterThanOrEqual(STANDALONE_SUMMARY_TOKENS);
		const clearedText = (out.messages[2].content as { text: string }[])[0].text;
		expect(clearedText.startsWith("B".repeat(CLEARED_RESULT_HEAD_CHARS))).toBe(true);
		expect(clearedText).toContain(`${4 * 20_000 - CLEARED_RESULT_HEAD_CHARS} more characters omitted`);
		expect(clearedText).toContain("session transcript");
		// The others are the very same objects; the input array is not mutated.
		expect(out.messages[4]).toBe(medium);
		expect(out.messages[6]).toBe(small);
		expect(req.messages[2]).toBe(big);
	});

	it("keeps clearing until the clamp is satisfied and never touches user or assistant text", () => {
		const req = request([user(tokensOf(8_000)), toolResult(tokensOf(8_000)), assistant(tokensOf(8_000)), toolResult(tokensOf(8_000))]);
		const { request: out, cleared } = fitToBudget(model(30_000), req, 32_000);
		expect(cleared).toBe(2);
		expect(out.messages[0]).toBe(req.messages[0]);
		expect(out.messages[2]).toBe(req.messages[2]);
	});

	it("stops when nothing is left to clear (the provider then decides)", () => {
		const req = request([user(tokensOf(50_000))]);
		expect(fitToBudget(model(40_000), req, 32_000)).toEqual({ request: { ...req, messages: [...req.messages] }, cleared: 0 });
	});
});

describe("clearToolResult", () => {
	it("keeps the tool result's identity fields and drops images", () => {
		const withImage = toolResult("text", { content: [{ type: "text", text: "text" }, { type: "image", data: "…", mimeType: "image/png" }], details: { n: 1 } });
		const out = clearToolResult(withImage) as { toolCallId: string; toolName: string; details: unknown; content: { type: string; text: string }[] };
		expect(out.toolCallId).toBe("t");
		expect(out.toolName).toBe("read");
		expect(out.details).toEqual({ n: 1 });
		expect(out.content).toHaveLength(1);
		expect(out.content[0].text).toContain("and 1 image omitted");
	});

	it("leaves non-tool-result messages alone", () => {
		const u = user("a");
		expect(clearToolResult(u)).toBe(u);
	});
});

describe("withoutUsage", () => {
	it("zeroes assistant usage so pi's clamp cannot anchor on the session request's totals, leaving everything else alone", () => {
		const usage = { input: 7, output: 1, cacheRead: 19_094, cacheWrite: 35_162, totalTokens: 54_264, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
		const messages = [user("a"), assistant("hi", usage as never), toolResult("r")];
		const out = withoutUsage(messages);
		expect(out[0]).toBe(messages[0]);
		expect(out[2]).toBe(messages[2]);
		expect(out[1]).toMatchObject({ role: "assistant", stopReason: "stop", usage: { totalTokens: 0, input: 0, cacheRead: 0, cost: usage.cost } });
		expect((messages[1] as { usage: { totalTokens: number } }).usage.totalTokens).toBe(54_264);
		// The clamp now counts the text, not the 54k the session reported.
		expect(clampMaxTokensToContext(model(40_000), request(out), 32_000)).toBeGreaterThan(30_000);
	});
});

describe("standaloneRequest", () => {
	const preparation = (messagesToSummarize: unknown[], previousSummary?: string) => ({
		messagesToSummarize: messagesToSummarize as never[],
		turnPrefixMessages: [],
		isSplitTurn: false,
		previousSummary,
	});

	it("sends the doomed span with the one-line system prompt, the instruction last, and no tools", () => {
		const doomed = [user("a"), assistant(), toolResult("r"), assistant()];
		const req = standaloneRequest(model(200_000), preparation(doomed), "instruction", 32_000);
		expect(req.systemPrompt).toBe(STANDALONE_SYSTEM_PROMPT);
		expect(req.tools).toBeUndefined();
		expect(req.messages.slice(0, 4)).toEqual(doomed);
		expect(req.messages[4]).toMatchObject({ role: "user", content: "instruction" });
	});

	it("zeroes the span's assistant usage (the clamp must count the standalone request, not the session's)", () => {
		const doomed = [user("a"), assistant("t", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 54_264 }), toolResult("r")];
		const req = standaloneRequest(model(40_000), preparation(doomed), "instruction", 32_000);
		expect((req.messages[1] as { usage: { totalTokens: number } }).usage.totalTokens).toBe(0);
		expect(clampMaxTokensToContext(model(40_000), req, 32_000)).toBeGreaterThanOrEqual(STANDALONE_SUMMARY_TOKENS);
	});

	it("reattaches a previous summary as the leading (user-rendered) compaction summary", () => {
		const req = standaloneRequest(model(200_000), preparation([user("a"), assistant()], "earlier"), "instruction", 32_000);
		expect(req.messages[0]).toMatchObject({ role: "user" });
		expect(JSON.stringify(req.messages[0].content)).toContain("earlier");
		expect(req.messages).toHaveLength(4);
	});

	it("trims an overflowing span so pi's clamp leaves the standalone room", () => {
		// A 40k window holding ~50k tokens of tool results: the shape that used to
		// come back with max_tokens 1 (probe P1) now fits.
		const doomed = [user("read all six"), assistant(), toolResult(tokensOf(30_000)), assistant(), toolResult(tokensOf(20_000)), assistant()];
		const req = standaloneRequest(model(40_000), preparation(doomed), "instruction", 32_000);
		expect(clampMaxTokensToContext(model(40_000), req, 32_000)).toBeGreaterThanOrEqual(STANDALONE_SUMMARY_TOKENS);
		expect((req.messages[2].content as { text: string }[])[0].text).toContain("cleared to fit the compaction request");
	});
});
