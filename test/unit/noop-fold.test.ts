import { describe, expect, it } from "vitest";
import { applyNoopFolds, decideFold, type FoldEntry, foldCompanion, foldSuffix } from "../../extensions/background/noop-fold.ts";

const wakeup = (timestamp = 1000, details?: { noOpStreak?: number; streakStartedAt?: number }): FoldEntry => ({ kind: "wakeup", timestamp, details });
const noopCall = (id = "c1", noop: unknown = true): FoldEntry => ({ kind: "assistant", toolCalls: [{ id, name: "schedule_wakeup", noop }], aborted: false });
const result = (id = "c1"): FoldEntry => ({ kind: "toolResult", toolCallId: id });

describe("decideFold (Claude Code's no-op fold rules)", () => {
	it("folds a tick that ended on schedule_wakeup noop:true, carrying the streak", () => {
		expect(decideFold([wakeup(1000), noopCall(), result()])).toEqual({ kind: "fold", priorStreak: 0, since: 1000 });
		expect(decideFold([wakeup(5000, { noOpStreak: 2, streakStartedAt: 1000 }), noopCall(), result()])).toEqual({ kind: "fold", priorStreak: 2, since: 1000 });
	});

	it("has nothing to fold before the first wakeup", () => {
		expect(decideFold([{ kind: "user" }, noopCall(), result()])).toEqual({ kind: "none" });
	});

	it("vetoes a tick that did work, was interrupted, or had the user in it", () => {
		expect(decideFold([wakeup(), noopCall("c1", false), result()])).toMatchObject({ reason: "model_reported_work" });
		expect(decideFold([wakeup(), { kind: "assistant", toolCalls: [], aborted: false }])).toMatchObject({ reason: "model_reported_work" });
		expect(decideFold([wakeup(), { kind: "user" }, noopCall(), result()])).toMatchObject({ reason: "foreign_user_input" });
		expect(decideFold([wakeup(), { kind: "assistant", toolCalls: [], aborted: true }])).toMatchObject({ reason: "tool_abort" });
		expect(decideFold([wakeup(), result("stray"), noopCall(), result()])).toMatchObject({ reason: "split_tool_pair" });
	});

	it("vetoes across a compaction or another scheduled fire, before or inside the tick", () => {
		expect(decideFold([wakeup(), { kind: "compaction" }, noopCall(), result()])).toMatchObject({ reason: "blocking_system_in_span" });
		expect(decideFold([wakeup(), { kind: "fire" }, noopCall(), result()])).toMatchObject({ reason: "blocking_system_in_span" });
		expect(decideFold([{ kind: "compaction" }, wakeup(), noopCall(), result()])).toMatchObject({ reason: "blocking_system_before_anchor" });
		// An earlier wakeup bounds the look-back.
		expect(decideFold([{ kind: "compaction" }, wakeup(), noopCall(), result(), wakeup(2000), noopCall("c2"), result("c2")])).toMatchObject({ kind: "fold" });
	});

	it("says it the way Claude Code does", () => {
		expect(foldCompanion(1)).toBe("[1 prior /loop wakeup found nothing actionable; loop is healthy.]");
		expect(foldCompanion(3)).toBe("[3 prior /loop wakeups found nothing actionable; loop is healthy.]");
		expect(foldSuffix(2, "Sep 25 1:30pm")).toBe(" · 2 no-op ticks since Sep 25 1:30pm");
	});
});

describe("applyNoopFolds (the model's context)", () => {
	type M = { role: string; customType?: string; details?: unknown; timestamp?: number; id: string };
	const note = (text: string, timestamp: number): M => ({ role: "user", id: `note:${text}`, timestamp });
	const w = (id: string, streak?: number): M => ({ role: "custom", customType: "wakeup", id, details: streak ? { noOpStreak: streak } : {}, timestamp: 1 });
	const m = (id: string, role = "assistant"): M => ({ role, id });

	it("leaves a context with no fold alone", () => {
		expect(applyNoopFolds([m("u", "user"), w("w1"), m("a1")], note)).toBeUndefined();
	});

	it("drops each folded tick and keeps only the latest note", () => {
		const context = [m("u", "user"), w("w1"), m("a1"), m("t1", "toolResult"), w("w2", 1), m("a2"), m("t2", "toolResult"), w("w3", 2), m("a3")];
		const ids = applyNoopFolds(context, note)!.map((x) => x.id);
		expect(ids).toEqual(["u", `note:${foldCompanion(2)}`, "w3", "a3"]);
	});
});
