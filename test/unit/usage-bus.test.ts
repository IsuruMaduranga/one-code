import { describe, expect, it, vi } from "vitest";
import { costOf, recordUsage, USAGE_CHANNEL, USAGE_ENTRY_TYPE, usageEntryCost, type UsageRecord } from "../../extensions/lib/usage-bus.ts";

describe("costOf", () => {
	it("reads cost.total from a usage-like object", () => {
		expect(costOf({ input: 100, output: 20, cost: { total: 0.0123 } })).toBe(0.0123);
	});

	it("returns 0 for missing, non-finite, or wrong-typed fields", () => {
		expect(costOf(undefined)).toBe(0);
		expect(costOf({})).toBe(0);
		expect(costOf({ cost: { total: "1.0" } })).toBe(0);
		expect(costOf({ cost: { total: Number.NaN } })).toBe(0);
	});
});

describe("recordUsage", () => {
	it("emits a record with the source and cost", () => {
		const emit = vi.fn();
		recordUsage({ events: { emit } }, "subagent", { input: 10, output: 2, cost: { total: 0.5 } });
		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0];
		expect(channel).toBe(USAGE_CHANNEL);
		expect(payload).toEqual({ source: "subagent", cost: 0.5 } satisfies UsageRecord);
	});

	it("persists the record as a session entry before announcing it", () => {
		const order: string[] = [];
		const emit = vi.fn(() => order.push("emit"));
		const appendEntry = vi.fn(() => order.push("append"));
		recordUsage({ events: { emit }, appendEntry }, "classifier", { cost: { total: 0.01 } });
		expect(appendEntry).toHaveBeenCalledWith(USAGE_ENTRY_TYPE, { source: "classifier", cost: 0.01 });
		expect(order).toEqual(["append", "emit"]);
	});

	it("skips emission when the call was unpriced", () => {
		const emit = vi.fn();
		recordUsage({ events: { emit } }, "classifier", { input: 10, output: 2, cost: { total: 0 } });
		recordUsage({ events: { emit } }, "reader", undefined);
		expect(emit).not.toHaveBeenCalled();
	});

	it("never throws when the emitter itself throws", () => {
		const emit = vi.fn(() => {
			throw new Error("bus down");
		});
		expect(() => recordUsage({ events: { emit } }, "reader", { output: 1, cost: { total: 0.1 } })).not.toThrow();
	});
});

describe("usageEntryCost", () => {
	it("reads the cost off a persisted usage entry and ignores everything else", () => {
		expect(usageEntryCost({ type: "custom", customType: USAGE_ENTRY_TYPE, data: { source: "recap", cost: 0.25 } })).toBe(0.25);
		expect(usageEntryCost({ type: "custom", customType: "one-code:recap", data: { cost: 0.25 } })).toBe(0);
		expect(usageEntryCost({ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } })).toBe(0);
		expect(usageEntryCost({ type: "custom", customType: USAGE_ENTRY_TYPE, data: { cost: "0.25" } })).toBe(0);
		expect(usageEntryCost(undefined)).toBe(0);
	});
});
