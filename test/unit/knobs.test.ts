import { afterEach, describe, expect, it } from "vitest";
import { resetConfigModeForTest } from "../../profile/claude-code/mode.ts";
import { knobNames, knobValue, readKnob } from "../../extensions/lib/knobs.ts";

afterEach(() => resetConfigModeForTest("claude-compatible"));

describe("environment knobs", () => {
	it("read the product's spelling first, then the provider's alias", () => {
		resetConfigModeForTest("claude-compatible");
		expect(knobNames("USE_POWERSHELL_TOOL")).toEqual(["ONECODE_USE_POWERSHELL_TOOL", "CLAUDE_CODE_USE_POWERSHELL_TOOL"]);
		expect(readKnob("USE_POWERSHELL_TOOL", { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" })).toEqual({ value: "1", name: "CLAUDE_CODE_USE_POWERSHELL_TOOL", borrowed: true });
		expect(readKnob("USE_POWERSHELL_TOOL", { ONECODE_USE_POWERSHELL_TOOL: "0", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" })).toEqual({ value: "0", name: "ONECODE_USE_POWERSHELL_TOOL", borrowed: false });
	});

	it("let a blank spelling give way to a set one, keep a blank when nothing else is set, and ignore a non-string in a settings env block", () => {
		resetConfigModeForTest("claude-compatible");
		expect(readKnob("LOOP_KEEPALIVE", { ONECODE_LOOP_KEEPALIVE: " ", CLAUDE_CODE_LOOP_KEEPALIVE: "1" })).toEqual({ value: "1", name: "CLAUDE_CODE_LOOP_KEEPALIVE", borrowed: true });
		expect(readKnob("LOOP_KEEPALIVE", { ONECODE_LOOP_KEEPALIVE: "", CLAUDE_CODE_LOOP_KEEPALIVE: "" })).toEqual({ value: "", name: "ONECODE_LOOP_KEEPALIVE", borrowed: false });
		expect(knobValue("LOOP_KEEPALIVE", { CLAUDE_CODE_LOOP_KEEPALIVE: "" })).toBe("");
		expect(readKnob("SUBAGENT_MODEL", { ONECODE_SUBAGENT_MODEL: 5, CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" })?.name).toBe("CLAUDE_CODE_SUBAGENT_MODEL");
	});

	it("drop the alias when the provider is switched off (independent mode)", () => {
		resetConfigModeForTest("independent");
		expect(knobNames("USE_POWERSHELL_TOOL")).toEqual(["ONECODE_USE_POWERSHELL_TOOL"]);
		expect(readKnob("USE_POWERSHELL_TOOL", { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" })).toBeUndefined();
		expect(knobValue("USE_POWERSHELL_TOOL", { ONECODE_USE_POWERSHELL_TOOL: "1" })).toBe("1");
	});

	it("have no alias for a knob the provider does not name", () => {
		expect(knobNames("LEDGER_STRICT")).toEqual(["ONECODE_LEDGER_STRICT"]);
	});
});
