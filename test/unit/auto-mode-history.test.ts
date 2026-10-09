import { describe, expect, it } from "vitest";
import { childHistoryCursor, classifierHistory, CLASSIFIER_TOOL_META } from "../../extensions/auto-mode/history.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });

describe("active classifier history", () => {
	it("preserves a permission-rule denial even when its read call is omitted", () => {
		const history = classifierHistory([
			call("r", "read", { path: "/restricted" }),
			{ type: "custom", customType: CLASSIFIER_TOOL_META, data: { toolCallId: "r", deniedSubject: "/restricted", rule: "Read(/restricted)" } },
		]);
		expect(history.transcript).toEqual([{ kind: "denied", tool: "read", subject: "/restricted", rule: "Read(/restricted)" }]);
	});

	it("does not replay facts about calls removed by compaction", () => {
		const history = classifierHistory([
			call("r", "bash", { command: "git reset --hard" }),
			{ type: "compaction", id: "c", firstKeptEntryId: "c", summary: "Earlier work was summarized." },
			{ type: "custom", customType: CLASSIFIER_TOOL_META, data: { toolCallId: "r", gitStatus: { clean: true } } },
		]);
		expect(history.transcript).toEqual([{ kind: "summary", text: "Earlier work was summarized." }]);
		expect(history.userMessages).toEqual([]);
	});

	it("uses only the latest summary and retains its kept tail before later entries", () => {
		const history = classifierHistory([
			{ type: "compaction", id: "c1", firstKeptEntryId: "c1", summary: "Old summary" },
			call("kept", "bash", { command: "printf x > probe.txt" }),
			{ type: "compaction", id: "c2", firstKeptEntryId: "kept", summary: "Latest summary" },
			{ type: "branch_summary", summary: "Another branch's work, not user authorization." },
		]);
		expect(history.transcript).toEqual([
			{ kind: "summary", text: "Latest summary" },
			{ kind: "tool", tool: "bash", input: { command: "printf x > probe.txt" } },
			{ kind: "summary", text: "Another branch's work, not user authorization." },
		]);
		expect(history.userMessages).toEqual([]);
	});
});

describe("a subagent's cursor into the main session", () => {
	it.each([
		{ startedBy: "agent", inFlight: ["read", "agent", "later"], expected: { throughToolCallId: "agent" } },
		{ startedBy: "old-agent", inFlight: ["first", "second"], expected: { beforeToolCallId: "first" } },
		{ startedBy: "old-agent", inFlight: [], expected: {} },
		{ startedBy: undefined, inFlight: ["first", "second"], expected: { throughToolCallId: "second" } },
	])("started by $startedBy with $inFlight in flight", ({ startedBy, inFlight, expected }) => {
		expect(childHistoryCursor(startedBy, inFlight, inFlight.at(-1))).toEqual(expected);
	});
});
