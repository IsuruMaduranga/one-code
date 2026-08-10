import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendJournal, hashAgentCall, readJournal, ReplayCursor } from "../../extensions/workflow/journal.ts";
import type { JournalEntry } from "../../extensions/workflow/types.ts";

function entry(callIndex: number, hash: string, output = 100): JournalEntry {
	return {
		callIndex,
		hash,
		result: { value: `result ${callIndex}`, tokens: { input: 10, output, total: 10 + output }, cost: 0.01 },
		timestamp: 1700000000000,
	};
}

describe("hashAgentCall", () => {
	it("is stable for identical inputs and ignores cosmetic options", () => {
		const a = hashAgentCall("do it", { model: "m", label: "one", phase: "Scan" });
		const b = hashAgentCall("do it", { model: "m", label: "two", phase: "Verify" });
		expect(a).toBe(b);
	});

	it("changes when behavioral inputs change", () => {
		const base = hashAgentCall("do it", {});
		expect(hashAgentCall("do it differently", {})).not.toBe(base);
		expect(hashAgentCall("do it", { model: "m" })).not.toBe(base);
		expect(hashAgentCall("do it", { effort: "high" })).not.toBe(base);
		expect(hashAgentCall("do it", { schema: { type: "object" } })).not.toBe(base);
		expect(hashAgentCall("do it", { agentType: "reviewer" })).not.toBe(base);
		expect(hashAgentCall("do it", { isolation: "worktree" })).not.toBe(base);
	});
});

describe("journal file round-trip", () => {
	it("appends and reads entries, skipping torn lines", () => {
		const path = join(mkdtempSync(join(os.tmpdir(), "wf-journal-")), "journal.jsonl");
		appendJournal(path, entry(0, "aaa"));
		appendJournal(path, entry(1, "bbb"));
		const entries = readJournal(path);
		expect(entries).toHaveLength(2);
		expect(entries[1].result.value).toBe("result 1");
	});

	it("returns [] for a missing file", () => {
		expect(readJournal("/nonexistent/journal.jsonl")).toEqual([]);
	});
});

describe("ReplayCursor", () => {
	it("replays the longest unchanged prefix, then goes live for good", () => {
		const cursor = new ReplayCursor([entry(0, "aaa"), entry(1, "bbb"), entry(2, "ccc")]);
		expect(cursor.match(0, "aaa")?.value).toBe("result 0");
		expect(cursor.match(1, "CHANGED")).toBeUndefined();
		// Index 2 exists with a matching hash, but the prefix is broken.
		expect(cursor.match(2, "ccc")).toBeUndefined();
	});

	it("goes live on an index gap", () => {
		const cursor = new ReplayCursor([entry(0, "aaa"), entry(2, "ccc")]);
		expect(cursor.match(0, "aaa")?.value).toBe("result 0");
		expect(cursor.match(1, "bbb")).toBeUndefined();
		expect(cursor.match(2, "ccc")).toBeUndefined();
	});
});
