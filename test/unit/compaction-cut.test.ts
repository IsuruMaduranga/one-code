import { describe, expect, it } from "vitest";
import { claudeCodeCut, type CutEntry, lastReplyCut, moveCut, spanMessages } from "../../extensions/compaction/cut.ts";

type Msg = { role: string; content?: unknown; stopReason?: string };
const msg = (id: string, role: string, extra: Partial<Msg> = {}): CutEntry & { message: Msg } => ({
	id,
	type: "message",
	message: { role, content: [{ type: "text", text: id }], ...extra },
});
const toMessages = (entry: CutEntry) => (entry.message ? [entry.message as Msg] : entry.type === "branch_summary" ? [{ role: "branchSummary" }] : []);

describe("lastReplyCut", () => {
	it("keeps from the last assistant reply and hands back what pi would have kept before it", () => {
		const entries = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant"), msg("t2", "toolResult"), msg("a3", "assistant")];
		const cut = lastReplyCut(entries, "u2");
		expect(cut?.firstKeptEntryId).toBe("a3");
		expect(cut?.later).toBe(true);
		expect(cut?.span.map((e) => e.id)).toEqual(["u2", "a2", "t2"]);
	});

	it("keeps a pending tool call's results after the kept reply", () => {
		const entries = [msg("u1", "user"), msg("a1", "assistant"), msg("t1", "toolResult"), msg("t2", "toolResult")];
		expect(lastReplyCut(entries, "u1")?.firstKeptEntryId).toBe("a1");
	});

	it("skips assistant messages that never reach the provider", () => {
		const entries = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			msg("u2", "user"),
			msg("a2", "assistant", { stopReason: "error" }),
			msg("a3", "assistant", { stopReason: "aborted" }),
			msg("a4", "assistant"),
			{ id: "e1", type: "context_edit", targetId: "a4", replacement: null },
		];
		expect(lastReplyCut(entries, "u1")?.firstKeptEntryId).toBe("a1");
	});

	it("never keeps an assistant message with nothing the provider would send", () => {
		const entries = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] } }];
		expect(lastReplyCut(entries, "u2")).toMatchObject({ firstKeptEntryId: "a1", later: false });
		expect(lastReplyCut(entries, "u1")).toMatchObject({ firstKeptEntryId: "a1", later: true });
	});

	it("moves pi's cut back to the reply when a prompt or notification followed it", () => {
		const entries = [msg("u1", "user"), msg("a1", "assistant"), msg("t1", "toolResult"), msg("n1", "custom")];
		const cut = lastReplyCut(entries, "n1");
		expect(cut?.firstKeptEntryId).toBe("a1");
		expect(cut?.later).toBe(false);
		expect(cut?.span.map((e) => e.id)).toEqual(["a1", "t1"]);
	});

	it("leaves pi's cut alone at the reply, off the branch, or with no reply in context", () => {
		const entries = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")];
		expect(lastReplyCut(entries, "a1")).toBeUndefined();
		expect(lastReplyCut(entries, "missing")).toBeUndefined();
		const summarizedAway = [msg("a0", "assistant"), msg("u1", "user"), { id: "c", type: "compaction", firstKeptEntryId: "u1" }, msg("u2", "user")];
		expect(lastReplyCut(summarizedAway, "u2")).toBeUndefined();
	});

	it("can keep a reply an earlier compaction kept", () => {
		const entries = [msg("u0", "user"), msg("a0", "assistant"), { id: "c", type: "compaction", firstKeptEntryId: "a0" }, msg("u1", "user")];
		expect(lastReplyCut(entries, "u1")?.firstKeptEntryId).toBe("a0");
	});
});

describe("spanMessages", () => {
	it("projects the span as pi does: omissions dropped, replacements applied, older compactions silent", () => {
		const entries: CutEntry[] = [
			msg("u1", "user"),
			{ id: "c0", type: "compaction" },
			msg("a1", "assistant"),
			msg("t1", "toolResult"),
			{ id: "b1", type: "branch_summary" },
			{ id: "e1", type: "context_edit", targetId: "a1", replacement: null },
			{ id: "e2", type: "context_edit", targetId: "t1", replacement: { content: "cleared" } },
		];
		const messages = spanMessages(entries.slice(0, 5), entries, toMessages);
		expect(messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "u1" }] },
			{ role: "toolResult", content: [{ type: "text", text: "cleared" }] },
			{ role: "branchSummary" },
		]);
	});
});

describe("moveCut", () => {
	const prep = { messagesToSummarize: [{ role: "user" }], turnPrefixMessages: [{ role: "assistant" }], isSplitTurn: true, previousSummary: "old" };

	it("folds a split turn's prefix and the newly summarized messages into the doomed span", () => {
		expect(moveCut(prep, [{ role: "toolResult" }], true)).toEqual({
			messagesToSummarize: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			previousSummary: "old",
		});
	});

	it("takes the kept reply and what follows it off the end of the span", () => {
		const span = { messagesToSummarize: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }], turnPrefixMessages: [], isSplitTurn: false };
		expect(moveCut(span, [{ role: "assistant" }, { role: "toolResult" }], false)?.messagesToSummarize).toEqual([{ role: "user" }]);
	});

	it("keeps pi's cut when the messages are not the span's tail or nothing would be left", () => {
		const span = { messagesToSummarize: [{ role: "user" }, { role: "assistant" }], turnPrefixMessages: [], isSplitTurn: false };
		expect(moveCut(span, [{ role: "toolResult" }], false)).toBeUndefined();
		expect(moveCut(span, [{ role: "user" }, { role: "assistant" }], false)).toBeUndefined();
		const stamped = { messagesToSummarize: [{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }], turnPrefixMessages: [], isSplitTurn: false };
		expect(moveCut(stamped, [{ role: "assistant", timestamp: 3 }], false)).toBeUndefined();
		expect(moveCut(stamped, [{ role: "assistant", timestamp: 2 }], false)?.messagesToSummarize).toEqual([{ role: "user", timestamp: 1 }]);
	});
});

describe("claudeCodeCut", () => {
	it("moves pi's preparation and kept entry to the last reply, and leaves them when nothing moves", () => {
		const entries = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant")];
		const prep = { firstKeptEntryId: "u2", messagesToSummarize: [entries[0].message, entries[1].message], turnPrefixMessages: [], isSplitTurn: false };
		const moved = claudeCodeCut(entries, prep, toMessages);
		expect(moved.firstKeptEntryId).toBe("a2");
		expect(moved.preparation.messagesToSummarize.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		const atReply = { ...prep, firstKeptEntryId: "a2" };
		expect(claudeCodeCut(entries, atReply, toMessages)).toEqual({ preparation: atReply, firstKeptEntryId: "a2" });
	});
});
