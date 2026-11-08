/**
 * One Code's subagent wording (profile/text/subagents/, profile/text/subagent-models/)
 * where the golden snapshot cannot reach it: the nested Agent tool, the
 * launch lines of a background run, a resident's SendMessage results, the
 * run failures and the catalog's tools clauses. The golden snapshot pins the
 * Agent tool and its catalog, the model menu, an unknown agent and model, the
 * spawned-agents list, a missing run, an inline resume and a fork's framing.
 */
import { describe, expect, it } from "vitest";
import { subagentModelsText } from "../../profile/text/subagent-models/index.ts";
import { subagentsText } from "../../profile/text/subagents/index.ts";
import { ALL_LIVE } from "./helpers/live.ts";

const subagentModels = subagentModelsText(ALL_LIVE);
const subagents = subagentsText(ALL_LIVE);

describe("One Code's subagent text", () => {
	it("closes each catalog row with Claude Code's tools clause", () => {
		expect(subagents.catalogRow({ name: "a", description: "d", tools: { kind: "all", builtIn: true } })).toBe("- a: d (Tools: *)");
		expect(subagents.catalogRow({ name: "a", description: "", tools: { kind: "all", builtIn: false } })).toBe("- a: (no description) (Tools: All tools)");
		expect(subagents.catalogRow({ name: "a", description: "d", tools: { kind: "allExcept", tools: ["Edit", "Write"] } })).toBe("- a: d (Tools: All tools except Edit, Write)");
		expect(subagents.catalogRow({ name: "a", description: "d", tools: { kind: "listed", tools: [] } })).toBe("- a: d (Tools: none)");
	});

	it("words the nested Agent tool's refusals", () => {
		expect(subagents.refused({ kind: "nestedOptions", options: ["model"] })).toMatch(/^`model` is not available .* Call again without it\.$/);
		expect(subagents.refused({ kind: "nestedOptions", options: ["model", "thinking"] })).toContain("are not available");
		expect(subagents.refused({ kind: "nestedUnknownAgent", catalog: ["- a: d"] })).toBe("`subagent_type` is required. Available agents:\n- a: d");
		expect(subagents.refused({ kind: "nestedNoBridge" })).toBe("Nested Agent call refused: no permission bridge is available to judge the delegation");
		expect(subagents.nestedAgentDescription({ catalog: ["- a: d"] })).toContain('Available agents:\n- a: d\n(No "fork" here');
	});

	it("words a background launch, line by line", () => {
		expect(subagents.launchLine({ kind: "running", name: "x-1", taskId: "t", logPath: "/l" })).toBe("⏳ x-1 (task t) running in background — interim output readable at /l");
		expect(subagents.launchLine({ kind: "startFailed", name: "x-1", osMessage: "boom" })).toBe("✗ x-1: could not start: boom");
		expect(subagents.launched({ lines: ["L"] })).toMatch(/^L\n\nCompletion \(with the agent's report\) will arrive/);
		expect(subagents.sentToResident({ name: "x", taskId: "t" })).toContain("You know nothing about the agent's result");
	});

	it("words a run cut short", () => {
		expect(subagents.failure({ kind: "aborted", why: "wallClock", output: "half" })).toBe("half\n\n[terminated: turn hit the wall-clock cap]");
		expect(subagents.failure({ kind: "aborted", why: "stopped", output: " " })).toBe("Subagent terminated before the turn finished.");
		expect(subagents.failure({ kind: "providerError", error: "401", output: "" })).toContain("not a task failure): 401");
		expect(subagents.stats({ toolCalls: 2 })).toBe("2 tools");
	});

	it("names the plan file's restriction only in plan mode", () => {
		expect(subagents.parentMode({ mode: "plan" })).toContain("Only read-only tools run now");
		expect(subagents.parentMode({ mode: "auto" })).toBe('The main session\'s permission mode is now "auto", and your tool calls are checked against it from here on.');
	});

	it("words the model notices a resolution leaves", () => {
		expect(subagentModels.notice({ kind: "aliasMissing", alias: "haiku", session: "openai/gpt" })).toBe('No "haiku" model in this session\'s provider family (openai/gpt).');
		expect(subagentModels.notice({ kind: "unavailable", wanted: "x", source: "default" })).toContain("(from the configured subagent default)");
		expect(subagentModels.settingPinned({ model: "a/b", otherProvider: "c/d" })).toContain("different provider than this session (c/d)");
		expect(subagentModels.costsMore({ model: "a/b", price: 15, session: "c/d", sessionPrice: 3 })).toBe(
			"Requested model a/b ($15/M in) costs more per input token than this session's model c/d ($3/M in).",
		);
	});
});
