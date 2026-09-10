import { describe, expect, it } from "vitest";
import { hashAgentCall } from "../../extensions/workflow/journal.ts";
import { parseWorkflowScript } from "../../extensions/workflow/script-source.ts";
import { runWorkflowScript, type WorkflowRuntimeOptions } from "../../extensions/workflow/vm-runtime.ts";
import { WorkflowScriptError } from "../../extensions/workflow/types.ts";
import { makeGlobals, type GlobalsOverrides } from "./workflow-test-helpers.ts";

const agentCall: GlobalsOverrides["agentCall"] = async (prompt) => ({
	value: `agent(${prompt})`,
	tokens: { input: 0, output: 1, total: 1 },
	cost: 0,
});

function run(script: string, args?: unknown, options?: WorkflowRuntimeOptions, overrides: GlobalsOverrides = {}) {
	const { meta, body } = parseWorkflowScript(script);
	const { globals, events, journal } = makeGlobals({ agentCall, args, ...overrides });
	return { result: runWorkflowScript(body, globals, `${meta.name}.js`, options), events, journal };
}

const META = "export const meta = { name: 't', description: 'test' }\n";

describe("runWorkflowScript", () => {
	it.each([
		"while (true) {}",
		"await Promise.resolve(); while (true) {}",
		"await agent('first'); while (true) {}",
		"while (true) { await Promise.resolve(); }",
	])("terminates runaway JavaScript without blocking the host: %s", async (body) => {
		let ticks = 0;
		const timer = setInterval(() => { ticks++; }, 10);
		try {
			await expect(run(META + body, undefined, { timeoutMs: 200 }).result).rejects.toThrow(/timed out/);
			expect(ticks).toBeGreaterThan(1);
			await expect(run(META + "return 'still usable'").result).resolves.toBe("still usable");
		} finally {
			clearInterval(timer);
		}
	});

	it.each(["await new Promise(() => {})", "await Promise.resolve(); while (true) {}"])(
		"cancels a stalled script promptly: %s", async (body) => {
			const controller = new AbortController();
			const { result } = run(META + body, undefined, { signal: controller.signal });
			const timer = setTimeout(() => controller.abort(), 100);
			try { await expect(result).rejects.toThrow(/aborted/); }
			finally { clearTimeout(timer); }
		},
	);

	it("does not time out a responsive worker while a slow agent runs", async () => {
		const { globals } = makeGlobals({
			agentCall: async () => {
				await new Promise((resolve) => setTimeout(resolve, 600));
				return { value: "slow result", tokens: { input: 0, output: 10, total: 10 }, cost: 0 };
			},
			budgetTotal: 50, concurrency: 1,
		});
		await expect(runWorkflowScript("return await agent('slow')", globals, "slow.js", { timeoutMs: 300 }))
			.resolves.toBe("slow result");
	});

	it("preserves fatal budget errors through worker parallel/pipeline callbacks", async () => {
		for (const body of [
			"return await parallel([() => agent('a'), () => agent('b')])",
			"return await pipeline(['a', 'b'], (item) => agent(item))",
		]) {
			let calls = 0;
			const { globals } = makeGlobals({
				agentCall: async () => {
					calls++;
					return { value: "ok", tokens: { input: 0, output: 10, total: 10 }, cost: 0 };
				},
				budgetTotal: 10, concurrency: 1,
			});
			const result = runWorkflowScript(body, globals);
			await expect(result).rejects.toBeInstanceOf(WorkflowScriptError);
			await expect(result).rejects.toThrow(/budget exhausted/);
			expect(calls).toBe(1);
		}
	});

	it("keeps budget reads synchronous and current after an agent result", async () => {
		await expect(run(META + "await agent('a'); return [budget.total, budget.spent(), budget.remaining()]").result)
			.resolves.toEqual([null, 1, Infinity]);
	});

	it("keeps ordinary callback failures as null and preserves pipeline arguments", async () => {
		await expect(run(META + `
const values = await pipeline(['a', 'b'], (prev, item, index) => prev + item + index, (prev) => prev + '!');
const failures = await parallel([() => { throw new Error('expected'); }, () => 'ok']);
return {values, failures};
`).result).resolves.toEqual({ values: ["aa0!", "bb1!"], failures: [null, "ok"] });
	});

	it("parallel() is a barrier that maps throwing thunks to null", async () => {
		await expect(run(META + `
return await parallel([async () => 'ok', async () => { throw new Error('boom'); }, () => agent('c')])
`).result).resolves.toEqual(["ok", null, "agent(c)"]);
	});

	it("parallel() assigns callIndexes in array order regardless of completion order", async () => {
		const delays: Record<string, number> = { slow: 30, fast: 5 };
		const { result, journal } = run(META + "return await parallel([() => agent('slow'), () => agent('fast')])", undefined, undefined, {
			agentCall: async (prompt) => {
				await new Promise((r) => setTimeout(r, delays[prompt] ?? 0));
				return { value: prompt, tokens: { input: 0, output: 1, total: 1 }, cost: 0 };
			},
		});
		await expect(result).resolves.toEqual(["slow", "fast"]);
		expect(journal.find((e) => e.hash === hashAgentCall("slow", {}))?.callIndex).toBe(0);
		expect(journal.find((e) => e.hash === hashAgentCall("fast", {}))?.callIndex).toBe(1);
	});

	it.each(["parallel(Array.from({ length: 4097 }, () => async () => null))", "pipeline(Array.from({ length: 4097 }, (_, i) => i), (x) => x)"])(
		"rejects oversized batches: %s", async (expr) => {
			await expect(run(`${META}return await ${expr}`).result).rejects.toThrow(/at most 4096 items \(got 4097\)/);
		},
	);

	it("names the in-flight call cap when a synchronous loop floods agent()", async () => {
		await expect(run(META + "const calls = []; for (let i = 0; i < 1001; i++) calls.push(agent('x')); return await Promise.all(calls)", undefined, undefined, {
			agentCall: () => new Promise(() => {}),
		}).result).rejects.toThrow(/agent limit reached \(1000/);
	});

	it("reports uncloneable results instead of hanging", async () => {
		await expect(run(META + "return () => 1").result).rejects.toThrow(/clone/);
	});

	it("runs a script end to end with top-level await and return", async () => {
		const { result } = run(`${META}
const one = await agent('first')
const both = await parallel([() => agent('a'), () => agent('b')])
return { one, both }
`);
		await expect(result).resolves.toEqual({ one: "agent(first)", both: ["agent(a)", "agent(b)"] });
	});

	it("exposes args and log()", async () => {
		const { result, events } = run(`${META}log('hello ' + args.who); return args.who`, { who: "user" });
		await expect(result).resolves.toBe("user");
		expect(events).toContainEqual({ type: "log", text: "hello user" });
	});

	it("blocks Math.random, Date.now, and argless new Date inside the vm only", async () => {
		for (const expr of ["Math.random()", "Date.now()", "new Date()", "Date()"]) {
			const { result } = run(`${META}return ${expr}`);
			await expect(result).rejects.toThrow(/unavailable in a workflow/);
		}
		// new Date(ms) stays usable, and the host realm is untouched.
		const { result } = run(`${META}return new Date(0).getTime()`);
		await expect(result).resolves.toBe(0);
		expect(() => Date.now()).not.toThrow();
		expect(() => Math.random()).not.toThrow();
	});

	it("surfaces script errors as WorkflowScriptError", async () => {
		const { result } = run(`${META}throw new Error('script blew up')`);
		await expect(result).rejects.toThrow(/script blew up/);
		expect(() => run(`${META}syntax error here(`)).toThrow(/does not parse/);
	});

	it("does not leak host globals into the vm", async () => {
		const { result } = run(`${META}return typeof process`);
		await expect(result).resolves.toBe("undefined");
	});
});
