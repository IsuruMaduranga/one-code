import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { parseWorkflowScript, wrapScriptBody } from "../../extensions/workflow/script-source.ts";

const VALID = `export const meta = {
  name: 'audit',
  description: 'Audit things',
  phases: [{ title: 'Scan', detail: 'find files' }, { title: 'Verify' }],
}
const found = await agent('scan')
return found
`;

describe("parseWorkflowScript", () => {
	it("lifts and validates the meta literal", () => {
		const { meta, body } = parseWorkflowScript(VALID);
		expect(meta.name).toBe("audit");
		expect(meta.description).toBe("Audit things");
		expect(meta.phases).toEqual([{ title: "Scan", detail: "find files" }, { title: "Verify" }]);
		expect(body).not.toContain("export const meta");
		expect(body).toContain("await agent('scan')");
	});

	it("accepts template literals without interpolation and negative numbers", () => {
		const { meta } = parseWorkflowScript(
			"export const meta = { name: `x`, description: `y`, phases: [], offset: -3 }\n",
		);
		expect((meta as unknown as { offset: number }).offset).toBe(-3);
	});

	it("rejects a script that does not start with the meta export", () => {
		expect(() => parseWorkflowScript("const a = 1\nexport const meta = { name: 'x', description: 'y' }")).toThrow(
			/must begin with/,
		);
	});

	it("rejects non-literal meta", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: someVar }")).toThrow(/pure literal/);
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', extra: fn() }")).toThrow(
			/pure literal/,
		);
	});

	it("rejects spread, computed keys, and __proto__", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', ...rest }")).toThrow();
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', [key]: 1 }")).toThrow(
			/computed/,
		);
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', __proto__: {} }")).toThrow(
			/__proto__/,
		);
	});

	it("rejects missing name/description and bad phases", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'x' }")).toThrow(/description/);
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', phases: [{}] }")).toThrow(
			/title/,
		);
	});

	it("rejects further imports/exports in the body", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'x', description: 'y' }\nimport fs from 'node:fs'"),
		).toThrow(/import\/export/);
	});

	it("rejects template interpolation in meta", () => {
		expect(() => parseWorkflowScript("export const meta = { name: `a${'b'}`, description: 'y' }")).toThrow(
			/interpolation/,
		);
	});
});

describe("wrapScriptBody", () => {
	it("produces a compilable script whose completion value is the async result", async () => {
		const { body } = parseWorkflowScript(VALID);
		const wrapped = wrapScriptBody(body);
		const context = vm.createContext({
			__workflow__: {
				agent: async () => "result",
				parallel: async () => [],
				pipeline: async () => [],
				workflow: async () => null,
				phase: () => {},
				log: () => {},
				console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
				args: undefined,
				budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
			},
		});
		const completion = new vm.Script(wrapped).runInContext(context);
		await expect(Promise.resolve(completion)).resolves.toBe("result");
	});
});
