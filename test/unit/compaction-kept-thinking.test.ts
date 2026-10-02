import { describe, expect, it } from "vitest";
import { withoutKeptThinking, withoutThinking } from "../../extensions/compaction/kept-thinking.ts";

const thinking = { type: "thinking", thinking: "plan", thinkingSignature: "sig" };
const redacted = { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true };
const text = (t: string) => ({ type: "text", text: t });
const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } };

const summary = { role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 1_000 };
const kept = { role: "assistant", content: [thinking, text("done"), call], timestamp: 900 };
const keptResult = { role: "toolResult", content: [text("file")], timestamp: 950 };
const later = { role: "assistant", content: [thinking, text("next")], timestamp: 1_200 };
const conversation = [summary, kept, keptResult, { role: "user", content: "go on", timestamp: 1_100 }, later];
/** The compaction entry's time, as `lib/compaction-boundary.ts` reads it off the branch. */
const COMPACTED = 1_000;

describe("withoutKeptThinking", () => {
	it("removes thinking only from assistant messages older than the compaction, keeping text and tool calls", () => {
		const result = withoutKeptThinking(conversation, "anthropic-messages", COMPACTED);
		expect(result?.[1]).toEqual({ ...kept, content: [text("done"), call] });
		expect(result?.slice(2)).toEqual(conversation.slice(2));
		expect(result?.[0]).toBe(summary);
	});

	it("gives the same bytes on every request", () => {
		expect(JSON.stringify(withoutKeptThinking(conversation, "anthropic-messages", COMPACTED))).toBe(
			JSON.stringify(withoutKeptThinking(structuredClone(conversation), "anthropic-messages", COMPACTED)),
		);
	});

	it("removes redacted thinking too, on Bedrock as well", () => {
		const messages: { role: string; timestamp: number; content?: unknown }[] = [summary, { role: "assistant", content: [redacted, text("ok")], timestamp: 500 }];
		expect(withoutKeptThinking(messages, "bedrock-converse-stream", COMPACTED)?.[1].content).toEqual([text("ok")]);
	});

	it("changes nothing on other APIs, without a compaction, or with no kept thinking", () => {
		expect(withoutKeptThinking(conversation, "openai-responses", COMPACTED)).toBeUndefined();
		expect(withoutKeptThinking(conversation, undefined, COMPACTED)).toBeUndefined();
		expect(withoutKeptThinking(conversation, "anthropic-messages", undefined)).toBeUndefined();
		expect(withoutKeptThinking(conversation, "anthropic-messages", Number.NaN)).toBeUndefined();
		expect(withoutKeptThinking([summary, keptResult, later], "anthropic-messages", COMPACTED)).toBeUndefined();
	});
});

describe("withoutThinking", () => {
	it("removes every assistant message's thinking on a signing API and leaves other APIs alone", () => {
		const messages = [kept, later];
		expect(withoutThinking(messages, "anthropic-messages").map((m) => m.content)).toEqual([[text("done"), call], [text("next")]]);
		expect(withoutThinking(messages, "openai-completions")).toBe(messages);
	});
});

describe("kept-thinking's place in the manifest", () => {
	it("runs its context hook before every extension that captures the request's messages", async () => {
		const { readFileSync } = await import("node:fs");
		const manifest: string[] = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).pi.extensions;
		const at = (name: string) => manifest.indexOf(`extensions/${name}/index.ts`);
		expect(at("kept-thinking")).toBeGreaterThanOrEqual(0);
		for (const later of ["skill", "background", "subagents", "recap", "btw", "compaction"]) {
			expect(at("kept-thinking"), later).toBeLessThan(at(later));
		}
	});
});

describe("latestCompaction", () => {
	it("finds the newest compaction, where its kept tail starts, and its time", async () => {
		const { inContextEntries, latestCompaction } = await import("../../extensions/lib/compaction-boundary.ts");
		const branch = [
			{ id: "a", type: "message" },
			{ id: "c0", type: "compaction", firstKeptEntryId: "a", timestamp: "2026-10-01T00:00:00.000Z" },
			{ id: "b", type: "message" },
			{ id: "c1", type: "compaction", firstKeptEntryId: "b", timestamp: "2026-10-02T00:00:00.000Z" },
			{ id: "d", type: "message" },
		];
		expect(latestCompaction(branch)).toEqual({ index: 3, keptStart: 2, time: Date.parse("2026-10-02T00:00:00.000Z") });
		expect(inContextEntries(branch).map((e) => e.id)).toEqual(["b", "c1", "d"]);
		const keepsNothing = [{ id: "a", type: "message" }, { id: "c", type: "compaction", firstKeptEntryId: "missing" }];
		expect(latestCompaction(keepsNothing)?.keptStart).toBe(1);
		expect(latestCompaction([{ id: "a", type: "message" }])).toBeUndefined();
	});
});
