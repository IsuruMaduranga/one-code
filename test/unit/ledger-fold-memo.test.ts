import { beforeEach, describe, expect, it } from "vitest";
import { foldOnce, foldSession } from "../../extensions/lib/ledger/fold-memo.ts";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { type EntryLike, makeRecord, RECORD, type RequestIdentity } from "../../extensions/lib/ledger/records.ts";
import { resetProcessStateForTest } from "../../extensions/lib/process-state.ts";

const live: RequestIdentity = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-6", auth: "key" };

const pending = (id: string): EntryLike => ({ type: "custom", id, customType: RECORD.pending, data: makeRecord("pending", "test", { id, text: id }) });

describe("the shared fold", () => {
	beforeEach(() => resetProcessStateForTest());

	it("reuses one fold while the session's branch and the identity stay the same", () => {
		const entries = [pending("p1")];
		const session = { getBranch: () => entries };
		const first = foldSession(session, live);
		expect(foldSession(session, live)).toBe(first);
		expect(first).toEqual(foldBranch(entries, live));
	});

	it("misses on an appended entry, even when the branch is the same list grown in place", () => {
		const entries = [pending("p1")];
		const session = { getBranch: () => entries };
		const first = foldSession(session, live);
		entries.push(pending("p2"));
		const second = foldSession(session, live);
		expect(second).not.toBe(first);
		expect(second.pending.map((item) => item.id)).toEqual(["p1", "p2"]);
	});

	it("misses on another leaf of the same length, a replaced entry, and another identity", () => {
		const owner = {};
		const a = [pending("p1"), pending("p2")];
		const first = foldOnce(owner, a, live);
		const b = [a[0], pending("p3")];
		const onB = foldOnce(owner, b, live);
		expect(onB.pending.map((item) => item.id)).toEqual(["p1", "p3"]);
		// The same ids, another object: a rebuilt branch is folded again.
		expect(foldOnce(owner, [a[0], { ...b[1] }], live)).not.toBe(onB);
		const onA = foldOnce(owner, a, live);
		expect(onA).not.toBe(first);
		expect(foldOnce(owner, a, { ...live, model: "claude-haiku-4-5" })).not.toBe(onA);
		const bare = foldOnce(owner, a, undefined);
		expect(foldOnce(owner, a, live)).not.toBe(bare);
	});

	it("keeps one memo per session, and folds without one when there is no owner", () => {
		const entries = [pending("p1")];
		const one = { getBranch: () => entries };
		const two = { getBranch: () => entries };
		expect(foldSession(one, live)).not.toBe(foldSession(two, live));
		expect(foldOnce(undefined, entries, live)).not.toBe(foldOnce(undefined, entries, live));
	});
});
