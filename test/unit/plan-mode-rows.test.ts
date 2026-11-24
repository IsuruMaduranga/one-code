/**
 * The plan-mode tools' transcript rows (extensions/safety/plan-mode/rows.ts)
 * and the no-call-line renderer they use (lib/ui/tui-render.ts rowRenderers):
 * Claude Code's blocks (findings §103), worded without naming the assistant.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enteredRows, exitedRows } from "../../extensions/safety/plan-mode/rows.ts";
import { rowRenderers } from "../../extensions/lib/ui/tui-render.ts";
import { plainTheme } from "./helpers/plain-theme.ts";
import { userDenialText } from "../../extensions/lib/consent/user-denial.ts";

const view = (isError = false, width = 60) => ({ theme: plainTheme, width, isError });

describe("plan mode's rows", () => {
	it("enter_plan_mode: the title and the dim line, no elbow", () => {
		expect(enteredRows({ planFilePath: "/p/plan.md" }, view())).toEqual(["● Entered plan mode", "  Exploring and planning an approach."]);
		expect(enteredRows({}, view())).toBeUndefined();
		expect(enteredRows({ planFilePath: "/p/plan.md" }, view(true))).toBeUndefined();
	});

	it("an approved plan: the title, where it was saved, then the plan under the elbow's indent", () => {
		const rows = exitedRows({ plan: "Plan: add x\n- step one\n", approved: true, planFilePath: join(homedir(), "plans", "a.md") }, view());
		expect(rows).toEqual(["● Approved the plan", `  ⎿  Plan saved to: ~/plans/a.md`, "     Plan: add x", "     - step one"]);
	});

	it("a rejected plan: the elbow line, then the plan in a box as wide as its longest line", () => {
		const rejected = { ...view(true), text: userDenialText("keep it to one step") };
		expect(exitedRows({ plan: "Plan: add x\n- a longer step", approved: false }, rejected)).toEqual([
			"  ⎿  Rejected the plan:",
			`     ╭${"─".repeat(17)}╮`,
			"     │ Plan: add x     │",
			"     │ - a longer step │",
			`     ╰${"─".repeat(17)}╯`,
		]);
	});

	it("leaves other results to the tool's ordinary rendering", () => {
		// No approver (a one-shot run) and an empty plan are errors with the plan file named, not rejections.
		expect(exitedRows({ plan: "x", approved: false, planFilePath: "/p" }, view(true))).toBeUndefined();
		expect(exitedRows({ planFilePath: "/p" }, view(true))).toBeUndefined();
		expect(exitedRows(undefined, view())).toBeUndefined();
	});
});

describe("rowRenderers", () => {
	const opts = { expanded: false, isPartial: false };
	const ctx = (isError: boolean) => ({ args: {}, isError, state: {} });

	it("draws no call line and the rows once the result settles", () => {
		const renderers = rowRenderers("Enter plan mode", () => ["● Row"]);
		expect(renderers.renderCall({}, plainTheme, ctx(false)).render(80)).toEqual([]);
		expect(renderers.renderResult({ content: [] }, opts, plainTheme, ctx(false)).render(80)).toEqual(["● Row"]);
		expect(renderers.renderResult({ content: [] }, { ...opts, isPartial: true }, plainTheme, ctx(false)).render(80)).toEqual([]);
	});

	it("falls back to the call line and the result text when the rows do not cover the result", () => {
		const renderers = rowRenderers("Exit plan mode", () => undefined);
		const lines = renderers.renderResult({ content: [{ type: "text", text: "the plan file is empty" }] }, opts, plainTheme, ctx(true)).render(80);
		expect(lines[0]).toBe("● Exit plan mode");
		expect(lines.join("\n")).toContain("the plan file is empty");
	});
});
