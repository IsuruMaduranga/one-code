/**
 * Claude Code's SubagentHandback for every child session
 * (lib/subagent-handback.ts): the tool, its closing reminder, the turn
 * tracker that reports a handed-back report (and falls back to the child's
 * final text), and the two runners that wire it in. Real pi SDK sessions on a
 * temp agent dir with no model: `prompt` is spied, and the spy calls the
 * child's own SubagentHandback tool.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import {
	HANDBACK_ALREADY_DELIVERED,
	HANDBACK_DELIVERED,
	HANDBACK_EMPTY,
	oneTurnHandbackSlot,
	SUBAGENT_HANDBACK_DESCRIPTION,
	SUBAGENT_HANDBACK_REMINDER,
	subagentHandbackExtension,
	subagentHandbackTool,
} from "../../extensions/lib/subagent-handback.ts";
import { childToolAllowlist } from "../../extensions/subagents/agents.ts";
import { forkTaskMessage } from "../../extensions/subagents/outcome.ts";
import { SubagentRuntime } from "../../extensions/subagents/runner.ts";
import { SessionTurnTracker } from "../../extensions/subagents/session-turns.ts";
import { AgentRunner } from "../../extensions/workflow/agent-session.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

type ToolResult = { content: Array<{ text: string }>; isError?: boolean; terminate?: boolean };

describe("the SubagentHandback tool", () => {
	it("carries Claude Code's description, reminder and schema", () => {
		const tool = subagentHandbackTool(oneTurnHandbackSlot());
		expect(tool.name).toBe("SubagentHandback");
		expect(tool.description).toBe(
			"Deliver your final report to the agent that spawned you (your caller). Use it once, for that hand-off only: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so do everything else first and put everything your caller needs in that one report. It is not a messaging channel: do not use it for progress updates or questions.\n\nOnly a report delivered through SubagentHandback reaches your caller; plain text you write at the end of your run is NOT delivered. There is no recipient parameter: the report can only go to your caller.",
		);
		expect(tool.description).toBe(SUBAGENT_HANDBACK_DESCRIPTION);
		expect(SUBAGENT_HANDBACK_REMINDER).toBe(
			"Your final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step. Only a SubagentHandback call reaches your caller as your result; plain text you write at the end is not delivered.",
		);
		const schema = tool.parameters as unknown as { type: string; properties: Record<string, { type: string; description: string }>; required: string[]; additionalProperties: boolean };
		expect(schema.properties).toEqual({ message: expect.objectContaining({ type: "string", description: "Your full report for your caller" }) });
		expect(schema.required).toEqual(["message"]);
		expect(schema.additionalProperties).toBe(false);
	});

	it("records the report once and ends the run", async () => {
		const slot = oneTurnHandbackSlot();
		const tool = subagentHandbackTool(slot);
		const run = (message: unknown) => tool.execute("h", { message } as never, undefined, undefined, {} as never) as Promise<ToolResult>;

		const delivered = await run("The file is app.py.");
		expect(delivered.content[0].text).toBe(HANDBACK_DELIVERED);
		expect(delivered.content[0].text).toBe("Report delivered to your caller.");
		expect(delivered.terminate).toBe(true);
		expect(delivered.isError).toBeUndefined();
		expect(slot.report).toBe("The file is app.py.");

		const again = await run("a second report");
		expect(again).toMatchObject({ isError: true });
		expect(again.content[0].text).toBe(HANDBACK_ALREADY_DELIVERED);
		expect(slot.report).toBe("The file is app.py.");
	});

	it("fails loud on an empty report, with the fix named", async () => {
		const slot = oneTurnHandbackSlot();
		const result = (await subagentHandbackTool(slot).execute("h", { message: "  " } as never, undefined, undefined, {} as never)) as ToolResult;
		expect(result).toMatchObject({ isError: true });
		expect(result.content[0].text).toBe(HANDBACK_EMPTY);
		expect(slot.report).toBeUndefined();
	});
});

describe("the hand-back extension a child loads", () => {
	it("registers the tool and puts the closing reminder on the child's messages from session start", async () => {
		const fake = createFakePi();
		const reminders: unknown[] = [];
		const deferred: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data));
		fake.events.on(DEFER_CHANNEL, (data) => deferred.push(data));
		subagentHandbackExtension(oneTurnHandbackSlot())(fake.pi as never);
		expect(fake.tools.has("SubagentHandback")).toBe(true);
		expect(deferred).toEqual([]);
		expect(reminders).toEqual([]);
		await fake.fire("session_start", { reason: "startup" });
		expect(reminders).toEqual([{ text: SUBAGENT_HANDBACK_REMINDER, scope: "every-turn", key: "subagent-handback", placement: "sticky-append" }]);
	});

	it("defers the tool in a fork, which sends the parent's tool list", () => {
		const fake = createFakePi();
		const deferred: Array<{ name: string }> = [];
		fake.events.on(DEFER_CHANNEL, (data) => deferred.push(data as { name: string }));
		subagentHandbackExtension(oneTurnHandbackSlot(), { deferred: true })(fake.pi as never);
		expect(deferred.map((d) => d.name)).toEqual(["SubagentHandback"]);
	});

	it("an agent file's tools allowlist keeps it, and a fork's framing points at it", () => {
		expect(childToolAllowlist(["Read"])).toContain("SubagentHandback");
		expect(forkTaskMessage("do it")).toContain("the report you hand back through SubagentHandback is returned to the parent conversation verbatim");
	});
});

describe("SessionTurnTracker: the handed-back report is the turn's result", () => {
	const assistant = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

	it("reports the hand-back over the final text, and the final text when the tool was never called", () => {
		const tracker = new SessionTurnTracker();
		tracker.process(assistant("Done, see the report."));
		expect(tracker.recordHandback("The report.")).toBe(true);
		expect(tracker.recordHandback("Another.")).toBe(false);
		tracker.process({ type: "agent_settled" });
		expect(tracker.turnOutcome().output).toBe("The report.");
		expect(tracker.transcript).toBe("The report.");

		// The next turn starts without a report and falls back to its text.
		tracker.beginTurn();
		tracker.process(assistant("Plain answer."));
		tracker.process({ type: "agent_settled" });
		expect(tracker.turnOutcome().output).toBe("Plain answer.");
		expect(tracker.transcript).toBe("The report.\n\n---\n\nPlain answer.");
	});

	it("an aborted turn stays failed even after a hand-back", () => {
		const tracker = new SessionTurnTracker();
		tracker.recordHandback("Partial.");
		tracker.markAborted();
		expect(tracker.turnOutcome()).toMatchObject({ failed: true, output: "Partial.\n\n[terminated before the turn finished]" });
	});
});

describe("the runners give every child the hand-back", () => {
	let agentDir: string;
	let cwd: string;
	beforeAll(() => {
		agentDir = mkdtempSync(join(tmpdir(), "handback-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "handback-cwd-"));
		mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".claude", "agents", "hb-reader.md"), "---\nname: hb-reader\ntools: Read\n---\nYou read.");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});
	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	afterEach(() => vi.restoreAllMocks());

	/** A child that hands its report back through its own tool, then writes other text. */
	const handBackInPrompt = (report: string) =>
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
			const tool = this.getToolDefinition("SubagentHandback");
			if (!tool) throw new Error("no SubagentHandback in the child");
			if (!this.getActiveToolNames().includes("SubagentHandback")) throw new Error("SubagentHandback is not active");
			await tool.execute("h1", { message: report } as never, undefined, undefined, {} as never);
			this.messages.push({ role: "assistant", content: [{ type: "text", text: "plain text the caller never sees" }] } as never);
		});

	it("an Agent run returns the handed-back report", async () => {
		handBackInPrompt("Report from the subagent.");
		const runtime = await SubagentRuntime.create(cwd);
		const outcome = await runtime.run({ cwd, task: "find it", onProgress: () => {} }).result;
		expect(outcome.output).toBe("Report from the subagent.");
		expect(outcome.failed).toBeUndefined();
	});

	it("keeps the tool for an agent whose tools allowlist leaves it out", async () => {
		handBackInPrompt("Reader's report.");
		const runtime = await SubagentRuntime.create(cwd);
		const agent = { name: "hb-reader", description: "", tools: ["read"], systemPrompt: "You read.", source: "project" };
		const outcome = await runtime.run({ cwd, task: "read it", agent: agent as never, onProgress: () => {} }).result;
		expect(outcome.output).toBe("Reader's report.");
	});

	it("a workflow agent returns the handed-back report, not its last message", async () => {
		handBackInPrompt("Workflow agent's report.");
		const runner = await AgentRunner.create({ cwd, defaultModel: undefined });
		const { value } = await runner.run("tabulate", {}, new AbortController().signal);
		expect(value).toBe("Workflow agent's report.");
	});

	it("a workflow agent without a hand-back still returns its last message", async () => {
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
			this.messages.push({ role: "assistant", content: [{ type: "text", text: "The last message." }] } as never);
		});
		const runner = await AgentRunner.create({ cwd, defaultModel: undefined });
		const { value } = await runner.run("tabulate", {}, new AbortController().signal);
		expect(value).toBe("The last message.");
	});

	it("a schema'd workflow agent hands back through structured_output and gets no SubagentHandback", async () => {
		const seen: string[][] = [];
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
			seen.push(this.getAllTools().map((t) => t.name));
		});
		const runner = await AgentRunner.create({ cwd, defaultModel: undefined });
		await runner.run("tabulate", { schema: { type: "object", properties: { a: { type: "string" } } } }, new AbortController().signal).catch(() => undefined);
		expect(seen[0]).toContain("structured_output");
		expect(seen[0]).not.toContain("SubagentHandback");
	});
});
