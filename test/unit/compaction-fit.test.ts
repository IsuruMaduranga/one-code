/**
 * Compaction review H2 (2026-09-05): an overflow-triggered compaction replayed
 * the request that had just overflowed, so pi's max_tokens clamp (or the
 * provider) returned nothing and pi's default summary served on every
 * overflow. The request shape is now decided by `replayFits`, and the
 * standalone shape is trimmed to the window by `fitToBudget`.
 */
import { describe, expect, it } from "vitest";
import {
	CLEARED_RESULT_HEAD_CHARS,
	CONTEXT_SAFETY_TOKENS,
	clearToolResult,
	estimateMessageTokens,
	fitToBudget,
	MIN_REPLAY_SUMMARY_TOKENS,
	replayFits,
	STANDALONE_SUMMARY_TOKENS,
	standaloneBudget,
	withoutUsage,
} from "../../extensions/compaction/fit.ts";
import { STANDALONE_SYSTEM_PROMPT, standaloneRequest } from "../../extensions/compaction/index.ts";

const user = (text: string) => ({ role: "user", content: text }) as never;
const assistant = (text = "…") => ({ role: "assistant", content: [{ type: "text", text }] }) as never;
const toolResult = (text: string, extra: Record<string, unknown> = {}) =>
	({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }], ...extra }) as never;

describe("replayFits (H2)", () => {
	it("never replays on overflow: the capture is the request that just failed", () => {
		expect(replayFits({ reason: "overflow", contextWindow: 200_000, tokensBefore: 10_000 })).toBe(false);
	});

	it("replays a manual or threshold compaction that leaves room for the summary", () => {
		// pi's default reserve (16 384) leaves ~12k after the safety margin.
		expect(replayFits({ reason: "threshold", contextWindow: 200_000, tokensBefore: 200_000 - 16_384 })).toBe(true);
		expect(replayFits({ reason: "manual", contextWindow: 90_000, tokensBefore: 30_000 })).toBe(true);
	});

	it("falls to the standalone shape when the capture would be clamped below the floor", () => {
		const tooFull = 200_000 - CONTEXT_SAFETY_TOKENS - MIN_REPLAY_SUMMARY_TOKENS + 1;
		expect(replayFits({ reason: "threshold", contextWindow: 200_000, tokensBefore: tooFull })).toBe(false);
		expect(replayFits({ reason: "manual", contextWindow: 50_000, tokensBefore: 49_000 })).toBe(false);
	});

	it("trusts the capture when the window is unknown (pi does not clamp then either)", () => {
		expect(replayFits({ reason: "manual", contextWindow: 0, tokensBefore: 10_000_000 })).toBe(true);
	});
});

describe("standaloneBudget", () => {
	it("reserves pi's safety margin, the summary's room, and the fixed request parts", () => {
		expect(standaloneBudget(100_000, 3_000)).toBe(100_000 - CONTEXT_SAFETY_TOKENS - STANDALONE_SUMMARY_TOKENS - 3_000);
		expect(standaloneBudget(0, 3_000)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("fitToBudget", () => {
	it("returns the messages untouched when they already fit", () => {
		const messages = [user("hi"), assistant(), toolResult("x".repeat(400))];
		const { messages: out, cleared } = fitToBudget(messages, 10_000);
		expect(cleared).toBe(0);
		expect(out).toEqual(messages);
		expect(out).not.toBe(messages);
	});

	it("clears the largest tool results first, keeping a landmark head and a pointer note", () => {
		const big = toolResult("B".repeat(40_000));
		const medium = toolResult("M".repeat(20_000));
		const small = toolResult("S".repeat(400));
		const messages = [user("read them"), assistant(), big, assistant(), medium, assistant(), small, assistant("done")];
		const before = estimateMessageTokens(big) + estimateMessageTokens(medium) + estimateMessageTokens(small);
		// Room for everything except the big one.
		const budget = before - estimateMessageTokens(big) + 800;
		const { messages: out, cleared } = fitToBudget(messages, budget);
		expect(cleared).toBe(1);
		const clearedText = (out[2] as { content: { text: string }[] }).content[0].text;
		expect(clearedText.startsWith("B".repeat(CLEARED_RESULT_HEAD_CHARS))).toBe(true);
		expect(clearedText).toContain(`${40_000 - CLEARED_RESULT_HEAD_CHARS} more characters omitted`);
		expect(clearedText).toContain("session transcript");
		// The others are the very same objects; the input array is not mutated.
		expect(out[4]).toBe(medium);
		expect(out[6]).toBe(small);
		expect(messages[2]).toBe(big);
		expect(out.map((m) => (m as { role: string }).role)).toEqual(messages.map((m) => (m as { role: string }).role));
	});

	it("keeps clearing until the estimate fits and stops at tool results (never user or assistant text)", () => {
		const messages = [user("U".repeat(8_000)), toolResult("A".repeat(8_000)), assistant("X".repeat(8_000)), toolResult("B".repeat(8_000))];
		const { messages: out, cleared } = fitToBudget(messages, 5_000);
		expect(cleared).toBe(2);
		expect(out[0]).toBe(messages[0]);
		expect(out[2]).toBe(messages[2]);
	});

	it("preserves the tool result's identity fields and drops images when clearing", () => {
		const withImage = toolResult("text", { content: [{ type: "text", text: "text" }, { type: "image", data: "…", mimeType: "image/png" }], details: { n: 1 } });
		const out = clearToolResult(withImage) as { toolCallId: string; toolName: string; details: unknown; content: { type: string; text: string }[] };
		expect(out.toolCallId).toBe("t");
		expect(out.toolName).toBe("read");
		expect(out.details).toEqual({ n: 1 });
		expect(out.content).toHaveLength(1);
		expect(out.content[0].text).toContain("and 1 image omitted");
	});
});

describe("withoutUsage", () => {
	it("zeroes assistant usage so pi's clamp cannot anchor on the session request's totals, leaving everything else alone", () => {
		const usage = { input: 7, output: 1, cacheRead: 19_094, cacheWrite: 35_162, totalTokens: 54_264, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
		const withUsage = { role: "assistant", content: [{ type: "text", text: "hi" }], usage, stopReason: "stop", timestamp: 5 } as never;
		const messages = [user("a"), withUsage, toolResult("r")];
		const out = withoutUsage(messages);
		expect(out[0]).toBe(messages[0]);
		expect(out[2]).toBe(messages[2]);
		expect(out[1]).toMatchObject({ role: "assistant", stopReason: "stop", timestamp: 5, usage: { totalTokens: 0, input: 0, cacheRead: 0, cost: { total: 0 } } });
		expect((messages[1] as { usage: { totalTokens: number } }).usage.totalTokens).toBe(54_264);
	});
});

describe("standaloneRequest", () => {
	const preparation = (messagesToSummarize: never[], previousSummary?: string) => ({
		messagesToSummarize,
		turnPrefixMessages: [],
		isSplitTurn: false,
		previousSummary,
	});

	it("sends the doomed span with the one-line system prompt and no tools", () => {
		const doomed = [user("a"), assistant(), toolResult("r"), assistant()];
		const request = standaloneRequest(200_000, preparation(doomed), "instruction");
		expect(request.systemPrompt).toBe(STANDALONE_SYSTEM_PROMPT);
		expect(request.tools).toBeUndefined();
		expect(request.messages).toEqual(doomed);
	});

	it("zeroes the span's assistant usage (the clamp must count the standalone request, not the session's)", () => {
		const usage = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 54_264, cost: { total: 1 } };
		const doomed = [user("a"), { role: "assistant", content: [{ type: "text", text: "t" }], usage, timestamp: 1 } as never, toolResult("r")];
		const request = standaloneRequest(40_000, preparation(doomed), "instruction");
		expect((request.messages[1] as { usage: { totalTokens: number } }).usage.totalTokens).toBe(0);
	});

	it("reattaches a previous summary as the leading compactionSummary message", () => {
		const request = standaloneRequest(200_000, preparation([user("a"), assistant()], "earlier"), "instruction");
		expect(request.messages[0]).toMatchObject({ role: "compactionSummary", summary: "earlier" });
		expect(request.messages).toHaveLength(3);
	});

	it("trims an overflowing span to the window instead of sending it whole", () => {
		// A 40k window holding ~50k tokens of tool results: the shape that used to
		// come back with max_tokens 1 (probe P1) now fits.
		const doomed = [user("read all six"), assistant(), toolResult("F".repeat(120_000)), assistant(), toolResult("G".repeat(80_000)), assistant()];
		const request = standaloneRequest(40_000, preparation(doomed), "instruction");
		const total = request.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		expect(total).toBeLessThanOrEqual(standaloneBudget(40_000, 0));
		expect((request.messages[2] as { content: { text: string }[] }).content[0].text).toContain("cleared to fit the compaction request");
	});
});
