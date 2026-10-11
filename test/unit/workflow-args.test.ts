/**
 * Weak models send a workflow's `args` list or object as a JSON-encoded string
 * (every Qwen 3.8 model, battery round 7); the tool's argument preparation
 * decodes it before the gate and hooks see the call.
 */
import { describe, expect, it } from "vitest";
import { prepareWorkflowArguments } from "../../extensions/workflow/args.ts";

describe("prepareWorkflowArguments", () => {
	it("decodes a JSON-encoded array or object", () => {
		expect(prepareWorkflowArguments({ script: "s", args: '["a.py","b.py"]' })).toEqual({ script: "s", args: ["a.py", "b.py"] });
		expect(prepareWorkflowArguments({ args: ' {"files":["a.py"]}' })).toEqual({ args: { files: ["a.py"] } });
	});

	it("passes every other value verbatim", () => {
		for (const args of ["plain text", "[not json", "42", '"quoted"', "null", 7, ["x"], { a: 1 }]) {
			expect(prepareWorkflowArguments({ args })).toEqual({ args });
		}
		expect(prepareWorkflowArguments({ script: "s" })).toEqual({ script: "s" });
		expect(prepareWorkflowArguments(undefined)).toBeUndefined();
	});
});
