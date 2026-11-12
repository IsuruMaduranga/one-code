import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { parseWorkflowScript, wrapScriptBody } from "../../extensions/agents/workflow/script-source.ts";
import type { ScriptProblem } from "../../extensions/agents/workflow/text.ts";
import { workflowResultText } from "../../extensions/agents/workflow/text.ts";

/** A script problem as the profile words it: what the parser throws. */
const problem = (p: ScriptProblem) => workflowResultText.scriptProblem(p);

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
		expect(() => parseWorkflowScript("const a = 1\nexport const meta = { name: 'x', description: 'y' }")).toThrow(problem({ kind: "noMeta" }));
	});

	it("rejects non-literal meta", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: someVar }")).toThrow(
			problem({ kind: "notLiteral", path: "meta.description", detail: "other" }),
		);
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', extra: fn() }")).toThrow(
			problem({ kind: "notLiteral", path: "meta.extra", detail: "other" }),
		);
	});

	it("rejects spread, computed keys, and __proto__", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', ...rest }")).toThrow(
			problem({ kind: "notLiteral", path: "meta", detail: "spreadOrMethod" }),
		);
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', [key]: 1 }")).toThrow(
			problem({ kind: "notLiteral", path: "meta", detail: "computedKey" }),
		);
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', __proto__: {} }")).toThrow(
			problem({ kind: "forbiddenKey", path: "meta", key: "__proto__" }),
		);
	});

	it("rejects missing name/description and bad phases", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'x' }")).toThrow(problem({ kind: "metaField", field: "description" }));
		expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y', phases: [{}] }")).toThrow(
			problem({ kind: "metaField", field: "phaseTitle" }),
		);
	});

	it("rejects further imports/exports in the body", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'x', description: 'y' }\nimport fs from 'node:fs'"),
		).toThrow(problem({ kind: "importExport" }));
	});

	it("rejects template interpolation in meta", () => {
		expect(() => parseWorkflowScript("export const meta = { name: `a${'b'}`, description: 'y' }")).toThrow(
			problem({ kind: "notLiteral", path: "meta.name", detail: "interpolation" }),
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
