import { describe, expect, it } from "vitest";
import { configuredDefaultLine, knobsNotApplied } from "../../extensions/lib/models/subagent-model-text.ts";

const knobs = { names: ["ONECODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"], limit: "which applies only on Anthropic models" };

describe("the /subagent status line for the configured default", () => {
	it("names an unset default, a setting, and auto with the knobs it hides", () => {
		expect(configuredDefaultLine(undefined, false, knobs)).toBe("subagentModel: (not set)");
		expect(configuredDefaultLine({ spec: "openai/gpt-6.1-sol", source: "setting" } as never, true, knobs)).toBe("subagentModel: openai/gpt-6.1-sol (from the subagentModel setting)");
		expect(configuredDefaultLine({ spec: "AUTO", source: "setting" } as never, true, knobs)).toBe(
			"subagentModel: auto (from the subagentModel setting): chosen automatically on every provider; ONECODE_SUBAGENT_MODEL and CLAUDE_CODE_SUBAGENT_MODEL are not applied",
		);
	});

	it("names the variable that set it, and why another tool's variable does not apply", () => {
		const env = { spec: "sonnet", source: "env", envVar: "CLAUDE_CODE_SUBAGENT_MODEL", borrowed: true } as never;
		expect(configuredDefaultLine(env, true, knobs)).toBe("subagentModel: sonnet (from CLAUDE_CODE_SUBAGENT_MODEL)");
		expect(configuredDefaultLine(env, false, knobs)).toBe(
			"subagentModel: sonnet (from CLAUDE_CODE_SUBAGENT_MODEL) — not applied: CLAUDE_CODE_SUBAGENT_MODEL is another tool's variable, which applies only on Anthropic models",
		);
	});

	it("agrees in number", () => {
		expect(knobsNotApplied(["A"])).toBe("A is not applied");
		expect(knobsNotApplied(["A", "B"])).toBe("A and B are not applied");
	});
});
