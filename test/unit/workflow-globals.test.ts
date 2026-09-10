import { describe, expect, it } from "vitest";
import { hashAgentCall, ReplayCursor } from "../../extensions/workflow/journal.ts";
import { createLimiter, createScriptGlobals, createRunAdmission } from "../../extensions/workflow/globals.ts";
import type { AgentCallFn } from "../../extensions/workflow/types.ts";
import { makeGlobals } from "./workflow-test-helpers.ts";

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

	it("stops queued agents when the first completion exhausts the budget", async () => {
		const { globals, state, events, journal } = makeGlobals({ budgetTotal: 50, concurrency: 1 });
		const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => globals.agent(`task ${i}`)));
		expect(settled.map((result) => result.status)).toEqual(["fulfilled", ...Array<string>(9).fill("rejected")]);
		expect((settled[1] as PromiseRejectedResult).reason.message).toMatch(/budget exhausted/);
		expect(state.outputTokens()).toBe(50);
		expect(events.filter((event) => event.type === "agentStart")).toHaveLength(1);
		expect(journal).toHaveLength(1);
		// Rejected queued calls give their admission slot back: only one agent ran.
		expect(state.agentCount()).toBe(1);
	});

	it("allows in-flight work to finish but does not start queued work after exhaustion", async () => {
		let started = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const { globals, state } = makeGlobals({
			budgetTotal: 50,
			concurrency: 2,
			agentCall: async () => {
				started++;
				await blocked;
				return { value: "done", tokens: { input: 0, output: 50, total: 50 }, cost: 0 };
			},
		});
		const result = Promise.all(Array.from({ length: 10 }, (_, i) => globals.agent(`task ${i}`)));
		expect(started).toBe(2);
		release();
		await expect(result).rejects.toThrow(/budget exhausted/);
		expect(started).toBe(2);
		expect(state.outputTokens()).toBe(100);
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

describe("callIndex determinism", () => {
	it("assigns callIndexes in invocation order regardless of completion order", async () => {
		// "slow" is invoked first but finishes last; its callIndex must still be 0.
		const delays: Record<string, number> = { slow: 30, fast: 5 };
		const { globals, journal } = makeGlobals({
			agentCall: async (prompt) => {
				await new Promise((r) => setTimeout(r, delays[prompt as string] ?? 0));
				return { value: prompt, tokens: { input: 0, output: 1, total: 1 }, cost: 0 };
			},
		});
		await Promise.all([globals.agent("slow"), globals.agent("fast")]);
		expect(journal.find((e) => e.hash === hashAgentCall("slow", {}))?.callIndex).toBe(0);
		expect(journal.find((e) => e.hash === hashAgentCall("fast", {}))?.callIndex).toBe(1);
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

describe("nested workflow accounting (S9)", () => {
	it("shares live budget and concurrency across the parent and sibling workflows", async () => {
		let calls = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const agentCall: AgentCallFn = async () => {
			calls++;
			await blocked;
			return { value: "done", tokens: { input: 0, output: 50, total: 50 }, cost: 0 };
		};
		const parent = makeGlobals({ agentCall, budgetTotal: 50, concurrency: 1 });
		const children = Array.from({ length: 2 }, () => makeGlobals({ agentCall, admission: parent.state.admission }));
		const results = Promise.allSettled([
			children[0].globals.agent("first"),
			parent.globals.agent("parent queued"),
			children[1].globals.agent("sibling queued"),
		]);
		expect(calls).toBe(1);
		release();
		const settled = await results;
		expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
		expect(calls).toBe(1);
		expect(parent.state.outputTokens()).toBe(50);
		expect(children[1].globals.budget.remaining()).toBe(0);
		await expect(children[1].globals.agent("new call")).rejects.toThrow(/budget exhausted/);
	});

	it("shares the agent-count limit across sibling workflows", async () => {
		const parent = makeGlobals({ maxAgents: 1 });
		const child = () => makeGlobals({ admission: parent.state.admission });
		await child().globals.agent("first");
		await expect(child().globals.agent("second")).rejects.toThrow(/agent limit/);
		expect(parent.state.agentCount()).toBe(1);
	});

	it("folds a child's agents and spend into the shared run totals", async () => {
		const admission = createRunAdmission({ budgetTotal: null, concurrency: 1 });
		const parent = createScriptGlobals({
			agentCall: async () => ({ value: "p", tokens: { input: 0, output: 0, total: 0 }, cost: 0 }),
			args: undefined,
			admission,
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		const child = createScriptGlobals({
			agentCall: async () => ({ value: "c", tokens: { input: 1, output: 40, total: 41 }, cost: 0.5 }),
			args: undefined,
			admission,
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		await child.globals.agent("do a thing");
		expect(parent.state.agentCount()).toBe(1);
		expect(parent.state.outputTokens()).toBe(40);
		expect(parent.state.cost()).toBe(0.5);
		expect(parent.globals.budget.spent()).toBe(40);
	});
});
