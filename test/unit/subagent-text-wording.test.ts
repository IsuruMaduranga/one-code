/**
 * The subagent results where the golden snapshot cannot reach them: the
 * nested Agent tool's refusals, the launch lines of a background run, a
 * resident's SendMessage results, the run failures, an empty reply, the
 * catalog's heading and tools clauses, and the model notices. The golden
 * snapshot pins the Agent tool and its catalog, the model menu, an unknown
 * agent and model, the spawned-agents list, a missing run, an inline resume
 * and a fork's framing.
 */
import { describe, expect, it } from "vitest";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";
import { subagentModelWordsInForce } from "../../extensions/lib/models/subagent-model.ts";

const subagentModels = subagentModelWordsInForce();

describe("the subagent result text", () => {
	it("closes each catalog row with Claude Code's tools clause", () => {
		expect(subagentResultText().catalogRow({ name: "a", description: "d", tools: { kind: "all", builtIn: true } })).toBe("- a: d (Tools: *)");
		expect(subagentResultText().catalogRow({ name: "a", description: "", tools: { kind: "all", builtIn: false } })).toBe("- a: (no description) (Tools: All tools)");
		expect(subagentResultText().catalogRow({ name: "a", description: "d", tools: { kind: "allExcept", tools: ["Edit", "Write"] } })).toBe("- a: d (Tools: All tools except Edit, Write)");
		expect(subagentResultText().catalogRow({ name: "a", description: "d", tools: { kind: "listed", tools: [] } })).toBe("- a: d (Tools: none)");
	});

	it("words the nested Agent tool's refusals", () => {
		expect(subagentResultText().refused({ kind: "nestedOptions", options: ["model"] })).toMatch(/^`model` is not available .* Call again without it\.$/);
		expect(subagentResultText().refused({ kind: "nestedOptions", options: ["model", "thinking"] })).toContain("are not available");
		expect(subagentResultText().refused({ kind: "nestedUnknownAgent", catalog: ["- a: d"] })).toBe("`subagent_type` is required. Available agents:\n- a: d");
		expect(subagentResultText().refused({ kind: "nestedNoBridge" })).toBe("Nested Agent call refused: no permission bridge is available to judge the delegation");
	});

	it("words a background launch, line by line", () => {
		expect(subagentResultText().launchLine({ kind: "running", name: "x-1", taskId: "t", logPath: "/l" })).toBe("⏳ x-1 (task t) running in background — output file: /l");
		expect(subagentResultText().launchLine({ kind: "startFailed", name: "x-1", osMessage: "boom" })).toBe("✗ x-1: could not start: boom");
		expect(subagentResultText().launched({ lines: ["L"], running: 1, outputFile: true })).toBe(
			"L\n\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\nDo NOT read or tail the output file while it runs. If the user asks for progress, say the agent is still running; you'll get a completion notification. Stop with task_stop; SendMessage reaches the agent even while it runs (the message waits for its next tool round or the end of its current reply).",
		);
		// No launch line names an output file: the result does not mention one.
		expect(subagentResultText().launched({ lines: ["L"], running: 1, outputFile: false })).toBe(
			"L\n\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\nIf the user asks for progress, say the agent is still running; you'll get a completion notification. Stop with task_stop; SendMessage reaches the agent even while it runs (the message waits for its next tool round or the end of its current reply).",
		);
		expect(subagentResultText().launched({ lines: ["L1", "L2"], running: 2, outputFile: true })).toContain("The agents are working in the background. You will be notified automatically when each one completes.");
		expect(subagentResultText().launched({ lines: ["L1", "L2"], running: 2, outputFile: true })).toContain("Do NOT read or tail the output file while they run.");
		expect(subagentResultText().sentToResident({ name: "x", taskId: "t" })).toBe(
			"Message sent to resident agent x (task t). The reply will arrive as a task notification on its own. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.",
		);
		for (const text of [subagentResultText().launched({ lines: ["L"], running: 1, outputFile: true }), subagentResultText().sent({ name: "x", taskId: "t" }), subagentResultText().nextTurn({ name: "x" })]) {
			expect(text).not.toContain("task_output");
		}
	});

	it("counts the running agents, not the result's lines", () => {
		const one =
			"\n\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\nDo NOT read or tail the output file while it runs. If the user asks for progress, say the agent is still running; you'll get a completion notification. Stop with task_stop; SendMessage reaches the agent even while it runs (the message waits for its next tool round or the end of its current reply).";
		const two =
			"\n\nThe agents are working in the background. You will be notified automatically when each one completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate these agents' work — avoid working with the same files or topics they are using.\nDo NOT read or tail the output file while they run. If the user asks for progress, say the agent is still running; you'll get a completion notification. Stop with task_stop; SendMessage reaches the agent even while it runs (the message waits for its next tool round or the end of its current reply).";
		// One agent and a rename note.
		expect(subagentResultText().launched({ lines: ["Note", "L"], running: 1, outputFile: true })).toBe(`Note\nL${one}`);
		// One agent launched, one that could not start.
		expect(subagentResultText().launched({ lines: ["L", "✗ x-2: could not start: boom"], running: 1, outputFile: true })).toBe(`L\n✗ x-2: could not start: boom${one}`);
		// Two agents launched.
		expect(subagentResultText().launched({ lines: ["L1", "L2"], running: 2, outputFile: true })).toBe(`L1\nL2${two}`);
	});

	it("fails a launch where no agent runs, with no promise of a notification", () => {
		expect(subagentResultText().refused({ kind: "noneLaunched", lines: ["Note", "✗ x-1: could not start: boom"] })).toBe(
			"Note\n✗ x-1: could not start: boom\n\nNo agent started, so no notification will arrive. Fix the problem above and call Agent again, or do the task yourself.",
		);
	});

	it("tells the model not to retry when a launch failed because the session is ending", () => {
		const text = subagentResultText().refused({ kind: "sessionEnding", lines: ["✗ x-1: the session ended before the agent started."] });
		expect(text).toBe(
			"✗ x-1: the session ended before the agent started.\n\nNo agent started, so no notification will arrive: the session is ending. Do not call Agent again; finish without it and tell the user what is left.",
		);
		expect(text).not.toContain("call Agent again,");
	});

	it("heads the agent catalog as Claude Code does and words each row", () => {
		const row = subagentResultText().catalogRow({ name: "editor", description: "Edits prose", tools: { kind: "all", builtIn: false } });
		expect(row.startsWith("- editor: Edits prose")).toBe(true);
		expect(subagentResultText().catalogBlock({ rows: [row] })).toMatch(/^Available agent types for the Agent tool:\n- editor: Edits prose/);
	});

	it("words a run cut short", () => {
		expect(subagentResultText().failure({ kind: "aborted", why: "wallClock", output: "half" })).toBe("half\n\n[terminated: turn hit the wall-clock cap]");
		expect(subagentResultText().failure({ kind: "aborted", why: "stopped", output: " " })).toBe("Subagent terminated before the turn finished.");
		expect(subagentResultText().failure({ kind: "providerError", error: "401", output: "" })).toContain("not a task failure): 401");
		expect(subagentResultText().stats({ toolCalls: 2 })).toBe("2 tools");
	});

	it("says a subagent returned no output", () => {
		expect(subagentResultText().noOutput).toBe("(Subagent completed but returned no output.)");
	});

	it("names the plan file's restriction only in plan mode", () => {
		expect(subagentResultText().parentMode({ mode: "plan" })).toContain("Only read-only tools run now");
		expect(subagentResultText().parentMode({ mode: "auto" })).toBe('The main session\'s permission mode is now "auto", and your tool calls are checked against it from here on.');
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
