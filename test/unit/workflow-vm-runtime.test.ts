import { describe, expect, it } from "vitest";
import { createScriptGlobals } from "../../extensions/workflow/globals.ts";
import { parseWorkflowScript } from "../../extensions/workflow/script-source.ts";
import { runWorkflowScript } from "../../extensions/workflow/vm-runtime.ts";
import type { RunProgressEvent } from "../../extensions/workflow/types.ts";

function run(script: string, args?: unknown) {
	const events: RunProgressEvent[] = [];
	const { meta, body } = parseWorkflowScript(script);
	const { globals } = createScriptGlobals({
		agentCall: async (prompt) => ({ value: `agent(${prompt})`, tokens: { input: 0, output: 1, total: 1 }, cost: 0 }),
		args,
		budgetTotal: null,
		concurrency: 4,
		signal: new AbortController().signal,
		onEvent: (e) => events.push(e),
	});
	return { result: runWorkflowScript(body, globals, `${meta.name}.js`), events };
}

const META = "export const meta = { name: 't', description: 'test' }\n";

describe("runWorkflowScript", () => {
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
