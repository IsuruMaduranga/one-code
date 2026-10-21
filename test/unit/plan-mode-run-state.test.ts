import { describe, expect, it } from "vitest";
import { parsePlanRun } from "../../extensions/plan-mode/run-state.ts";

describe("a plan-mode run as the branch records it", () => {
	const path = "/plans/a.md";

	it("reads a run for its plan file, with the mode it came from", () => {
		expect(parsePlanRun({ path, existed: false, modeBeforePlan: "default" }, path)).toEqual({ existed: false, modeBeforePlan: "default" });
		expect(parsePlanRun({ path, existed: true }, path)).toEqual({ existed: true });
	});

	it("reads nothing for another file, a malformed record or none", () => {
		expect(parsePlanRun({ path: "/plans/b.md", existed: true }, path)).toBeUndefined();
		expect(parsePlanRun({ path, existed: "yes" }, path)).toBeUndefined();
		expect(parsePlanRun(null, path)).toBeUndefined();
		expect(parsePlanRun(undefined, path)).toBeUndefined();
	});

	it("drops a mode it came from that is plan itself or unknown", () => {
		expect(parsePlanRun({ path, existed: true, modeBeforePlan: "plan" }, path)).toEqual({ existed: true });
		expect(parsePlanRun({ path, existed: true, modeBeforePlan: "sideways" }, path)).toEqual({ existed: true });
	});
});
