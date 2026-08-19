import { describe, expect, it, vi } from "vitest";
import { costOf, recordUsage, USAGE_CHANNEL, type UsageRecord } from "../../extensions/lib/usage-bus.ts";

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
