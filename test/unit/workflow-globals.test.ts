import { describe, expect, it } from "vitest";
import { hashAgentCall, ReplayCursor } from "../../extensions/workflow/journal.ts";
import { createLimiter, createScriptGlobals, type ScriptGlobalsOptions } from "../../extensions/workflow/globals.ts";
import type { AgentCallFn, JournalEntry, RunProgressEvent } from "../../extensions/workflow/types.ts";

function makeGlobals(overrides: Partial<ScriptGlobalsOptions> = {}) {
	const events: RunProgressEvent[] = [];
	const journal: JournalEntry[] = [];
	const agentCall: AgentCallFn = async (prompt) => ({
		value: `done: ${prompt}`,
		tokens: { input: 10, output: 50, total: 60 },
		cost: 0.01,
	});
	const options: ScriptGlobalsOptions = {
		agentCall,
		args: undefined,
		budgetTotal: null,
		concurrency: 4,
		signal: new AbortController().signal,
		onEvent: (e) => events.push(e),
		onJournal: (e) => journal.push(e),
		now: () => 1700000000000,
		...overrides,
	};
	return { ...createScriptGlobals(options), events, journal };
}

describe("createLimiter", () => {
	it("never exceeds the limit", async () => {
		const limiter = createLimiter(2);
		let active = 0;
		let peak = 0;
		const task = () =>
			limiter(async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
			});
		await Promise.all(Array.from({ length: 10 }, task));
		expect(peak).toBe(2);
	});
});

describe("agent()", () => {
	it("returns the agent value and journals the call", async () => {
		const { globals, journal, state } = makeGlobals();
		const value = await globals.agent("scan files");
		expect(value).toBe("done: scan files");
		expect(journal).toHaveLength(1);
		expect(journal[0].callIndex).toBe(0);
		expect(journal[0].hash).toBe(hashAgentCall("scan files", {}));
		expect(state.agentCount()).toBe(1);
		expect(state.outputTokens()).toBe(50);
	});

	it("resolves null when the agent fails, without journaling", async () => {
		const { globals, journal, events } = makeGlobals({
			agentCall: async () => {
				throw new Error("provider exploded");
			},
		});
		await expect(globals.agent("doomed")).resolves.toBeNull();
		expect(journal).toHaveLength(0);
		expect(events.some((e) => e.type === "agentEnd" && e.text?.includes("provider exploded"))).toBe(true);
	});

	it("throws on the agent-count cap and on an exhausted budget", async () => {
		const capped = makeGlobals({ maxAgents: 1 });
		await capped.globals.agent("one");
		await expect(capped.globals.agent("two")).rejects.toThrow(/agent limit/);

		const budgeted = makeGlobals({ budgetTotal: 40 });
		await budgeted.globals.agent("one"); // spends 50 > 40
		await expect(budgeted.globals.agent("two")).rejects.toThrow(/budget exhausted/);
	});

	it("throws once aborted", async () => {
		const controller = new AbortController();
		const { globals } = makeGlobals({ signal: controller.signal });
		controller.abort();
		await expect(globals.agent("x")).rejects.toThrow(/aborted/);
	});

	it("tags calls with the current phase, letting opts.phase override", async () => {
		const { globals, events } = makeGlobals();
		globals.phase("Scan");
		await globals.agent("a");
		await globals.agent("b", { phase: "Verify" });
		const ends = events.filter((e) => e.type === "agentEnd");
		expect(ends[0].phase).toBe("Scan");
		expect(ends[1].phase).toBe("Verify");
	});

	it("replays journaled results without calling the agent", async () => {
		let calls = 0;
		const hash = hashAgentCall("cached", {});
		const cursor = new ReplayCursor([
			{
				callIndex: 0,
				hash,
				result: { value: "from journal", tokens: { input: 1, output: 25, total: 26 }, cost: 0.005 },
				timestamp: 1,
			},
		]);
		const { globals, state } = makeGlobals({
			replay: cursor,
			agentCall: async (prompt) => {
				calls++;
				return { value: `live: ${prompt}`, tokens: { input: 0, output: 10, total: 10 }, cost: 0 };
			},
		});
		expect(await globals.agent("cached")).toBe("from journal");
		expect(calls).toBe(0);
		expect(state.outputTokens()).toBe(25); // carried forward
		expect(await globals.agent("new call")).toBe("live: new call");
		expect(calls).toBe(1);
	});
});

describe("parallel()", () => {
	it("is a barrier that maps throwing thunks to null", async () => {
		const { globals } = makeGlobals();
		const results = await globals.parallel([
			async () => "ok",
			async () => {
				throw new Error("boom");
			},
			() => globals.agent("c"),
		]);
		expect(results).toEqual(["ok", null, "done: c"]);
	});

	it("assigns callIndexes in array order regardless of completion order", async () => {
		const delays = [30, 5];
		const seen: Array<{ prompt: string; callIndex: number }> = [];
		const { globals } = makeGlobals({
			agentCall: async (prompt, _opts, meta) => {
				await new Promise((r) => setTimeout(r, delays[meta.callIndex]));
				seen.push({ prompt, callIndex: meta.callIndex });
				return { value: prompt, tokens: { input: 0, output: 1, total: 1 }, cost: 0 };
			},
		});
		await globals.parallel([() => globals.agent("slow"), () => globals.agent("fast")]);
		expect(seen.find((s) => s.prompt === "slow")?.callIndex).toBe(0);
		expect(seen.find((s) => s.prompt === "fast")?.callIndex).toBe(1);
	});

	it("rejects oversized batches", async () => {
		const { globals } = makeGlobals();
		const thunks = Array.from({ length: 4097 }, () => async () => null);
		await expect(globals.parallel(thunks)).rejects.toThrow(/at most 4096/);
	});
});

describe("pipeline()", () => {
	it("chains stages per item with (prev, item, index) and no barrier", async () => {
		const { globals } = makeGlobals();
		const results = await globals.pipeline(
			["a", "b"],
			async (prev) => `${prev}1`,
			async (prev, item, index) => `${prev}|${item}|${index}`,
		);
		expect(results).toEqual(["a1|a|0", "b1|b|1"]);
	});

	it("drops an item to null when a stage throws, keeping others", async () => {
		const { globals } = makeGlobals();
		const results = await globals.pipeline(["ok", "bad"], async (prev) => {
			if (prev === "bad") throw new Error("stage failed");
			return prev;
		});
		expect(results).toEqual(["ok", null]);
	});
});

describe("budget + workflow()", () => {
	it("exposes budget arithmetic", async () => {
		const { globals } = makeGlobals({ budgetTotal: 200 });
		expect(globals.budget.total).toBe(200);
		expect(globals.budget.remaining()).toBe(200);
		await globals.agent("x");
		expect(globals.budget.spent()).toBe(50);
		expect(globals.budget.remaining()).toBe(150);
	});

	it("workflow() throws when nesting is not available", async () => {
		const { globals } = makeGlobals();
		await expect(globals.workflow("child")).rejects.toThrow(/one level/);
	});
});
