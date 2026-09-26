import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../../extensions/auto-mode/actions.ts";
import backgroundExtension from "../../extensions/background/index.ts";
import { type BackgroundTask, TASK_REGISTER_CHANNEL } from "../../extensions/background/registry.ts";
import { DEFAULT_COALESCE_MS } from "../../extensions/lib/notifications.ts";
import { SUBAGENT_GATE_CHANNEL } from "../../extensions/permissions/subagent-gate.ts";
import * as defaults from "../../extensions/subagents/default-model.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import type { ChildOutcome } from "../../extensions/subagents/outcome.ts";
import { SubagentRuntime } from "../../extensions/subagents/runner.ts";
import type { AgentRunRecord } from "../../extensions/subagents/runs.ts";
import { emptyUsage } from "../../extensions/subagents/usage.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model = (id: string, input: string[], cost: number) => ({
	provider: "openai", id, name: id, input, cost: { input: cost, output: cost * 4 },
});
const session = model("gpt-5-main", ["text", "image"], 2);
const textOnly = model("gpt-5-flash-text", ["text"], 0.6);
const vision = model("gpt-5-flash-vision", ["text", "image"], 0.7);
const outcome = (failed = false): ChildOutcome => ({ output: "Agent output", toolCalls: 0, usage: emptyUsage(), actions: [], failed });

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "subagent-wiring-"));
	vi.useFakeTimers();
	vi.spyOn(defaults, "loadSubagentDefault").mockReturnValue(undefined);
	vi.spyOn(defaults, "persistSubagentModel").mockImplementation(() => {});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

async function mount(records: AgentRunRecord[] = [], sessionModel = session, mode = "tui") {
	const fake = createFakePi();
	const tasks = new Map<string, BackgroundTask>();
	fake.events.on(TASK_REGISTER_CHANNEL, (task) => {
		const registered = task as BackgroundTask;
		tasks.set(registered.id, registered);
	});
	backgroundExtension(fake.pi as never);
	subagentsExtension(fake.pi as never);
	const ctx = createFakeCtx({
		cwd: dir, mode, model: sessionModel,
		modelRegistry: {
			getAvailable: () => [session, textOnly, vision],
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })),
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionDir: () => dir,
			getSessionFile: () => undefined,
			getBranch: () => records.length ? [{ type: "message", message: { role: "toolResult", toolName: "Agent", details: { agentRuns: records } } }] : [],
		},
	});
	await fake.fire("session_start", {}, ctx);
	await fake.fire("before_agent_start", {}, ctx);
	const call = (name: string, params: unknown) => fake.tools.get(name)!.execute("call", params, undefined, undefined, ctx);
	const notices = () => (ctx._notified as Array<{ message: string }>).map((n) => n.message).join("\n");
	const messages = () => fake.sentMessages.map((m) => JSON.stringify(m.message.content)).join("\n");
	return { fake, ctx, tasks, call, notices, messages };
}

describe("subagent model command", () => {
	it("reports the image-capable effective default for an existing text-only setting", async () => {
		vi.mocked(defaults.loadSubagentDefault).mockReturnValue({ spec: "openai/gpt-5-flash-text", source: "subagentModel setting" });
		const h = await mount();
		await h.fake.commands.get("subagent")!.handler("status", h.ctx);
		expect(h.notices()).toContain("effective: openai/gpt-5-main");
		expect(h.notices()).not.toContain("effective: openai/gpt-5-flash-text");
	});

	it("rejects a text-only default and offers an image-capable fallback without saving", async () => {
		vi.mocked(defaults.loadSubagentDefault).mockReturnValue({ spec: "openai/gpt-5-flash-text", source: "subagentModel setting" });
		const h = await mount();
		await h.fake.commands.get("subagent")!.handler("openai/gpt-5-flash-text", h.ctx);
		expect(defaults.persistSubagentModel).not.toHaveBeenCalled();
		expect(h.notices()).toContain("is text-only");
		expect(h.notices()).toContain("openai/gpt-5-main ($2/M in) — the default");
		expect(h.notices()).not.toContain("- openai/gpt-5-flash-text");
	});

	it.each([session, textOnly])("saves a compatible model for a $id session", async (sessionModel) => {
		const h = await mount([], sessionModel);
		const chosen = sessionModel === session ? vision : textOnly;
		await h.fake.commands.get("subagent")!.handler(`openai/${chosen.id}`, h.ctx);
		expect(defaults.persistSubagentModel).toHaveBeenCalledWith(`openai/${chosen.id}`, expect.any(String), "openai");
	});
});

describe("subagent task_stop", () => {
	it.each([false, true])("keeps a stopped turn distinct from a resumed run during review (repeat stop=%s)", async (repeatStop) => {
		const runtime = fakeResident(true, [{ toolName: "read", subject: "file.ts" }]);
		let finishResume!: (value: ChildOutcome) => void;
		runtime.runner.run.mockReturnValue({
			result: new Promise<ChildOutcome>((resolve) => { finishResume = resolve; }),
			kill: vi.fn(),
			snapshot: () => ({ text: "Resumed output", toolCalls: 0, usage: emptyUsage() }),
		});
		const h = await mount();
		let review: SubagentActionsPayload | undefined;
		h.fake.events.on(SUBAGENT_ACTIONS_CHANNEL, (payload) => { review = payload as SubagentActionsPayload; });
		const result = await h.call("Agent", { subagent_type: "general-purpose", task: "Check the code" }) as { details: { agentRuns: AgentRunRecord[] } };
		const record = result.details.agentRuns[0];
		writeFileSync(join(record.sessionSearchDir, "child.jsonl"), "");
		await h.call("task_stop", { task_id: record.taskId });
		expect(review?.onReview).toBeDefined();
		const reply = await h.call("SendMessage", { to: record.taskId, message: "Resume" }) as { details: { taskId: string } };
		if (repeatStop) await h.call("task_stop", { task_id: record.taskId });
		review!.onReview!(undefined);
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		expect(h.tasks.get(record.taskId)?.status).toBe("stopped");
		expect(h.messages()).toContain("<status>killed</status>");
		h.fake.sentMessages.length = 0;
		finishResume(outcome());
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		expect(h.tasks.get(reply.details.taskId)?.status).toBe("completed");
		expect(h.messages()).toContain("<status>completed</status>");
	});

	it.each(["initial", "reply"])("does not relabel a completed %s turn when stopped during its hand-back review", async (kind) => {
		const runtime = fakeResident();
		const h = await mount();
		const result = await h.call("Agent", { subagent_type: "general-purpose", task: "Check the code" }) as { details: { agentRuns: AgentRunRecord[] } };
		const agentId = result.details.agentRuns[0].taskId;
		let taskId = agentId;
		if (kind === "reply") {
			runtime.finish();
			await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
			h.fake.sentMessages.length = 0;
			const reply = await h.call("SendMessage", { to: agentId, message: "Check again" }) as { details: { taskId: string } };
			taskId = reply.details.taskId;
		}
		let review: SubagentActionsPayload | undefined;
		h.fake.events.on(SUBAGENT_ACTIONS_CHANNEL, (payload) => { review = payload as SubagentActionsPayload; });
		runtime.finish([{ toolName: "read", subject: "file.ts" }]);
		expect(review?.onReview).toBeDefined();
		await h.call("task_stop", { task_id: taskId });
		review!.onReview!(undefined);
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		expect(h.tasks.get(taskId)?.status).toBe("completed");
		expect(h.messages()).toContain("<status>completed</status>");
		expect(h.messages()).not.toContain("<status>killed</status>");
	});

	it.each([false, true])("marks a fresh resident stopped and notifies killed (failed=%s)", async (failed) => {
		const runtime = fakeResident(failed);
		const h = await mount();
		const result = await h.call("Agent", { subagent_type: "general-purpose", task: "Check the code" }) as { details: { agentRuns: AgentRunRecord[] } };
		const taskId = result.details.agentRuns[0].taskId;
		await h.call("task_stop", { task_id: taskId });
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		expect(runtime.handle.kill).toHaveBeenCalledOnce();
		expect(h.tasks.get(taskId)?.status).toBe("stopped");
		expect(h.messages()).toContain("<status>killed</status>");
		expect(h.messages()).not.toContain("[Subagent hand-back]");
	});

	it("uses the persistent agent id when stopping a resident message task", async () => {
		const runtime = fakeResident();
		const h = await mount();
		const result = await h.call("Agent", { subagent_type: "general-purpose", task: "Check the code" }) as { details: { agentRuns: AgentRunRecord[] } };
		const agentId = result.details.agentRuns[0].taskId;
		runtime.finish();
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		h.fake.sentMessages.length = 0;
		const reply = await h.call("SendMessage", { to: agentId, message: "Check again" }) as { details: { taskId: string } };
		expect(reply.details.taskId).not.toBe(agentId);
		await h.call("task_stop", { task_id: reply.details.taskId });
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		expect(h.tasks.get(reply.details.taskId)?.status).toBe("stopped");
		expect(h.messages()).toContain(`<task-id>${reply.details.taskId}</task-id>`);
		expect(h.messages()).toContain("<status>killed</status>");
		expect(h.messages()).not.toContain("[Subagent hand-back]");
	});

	it("marks a stopped resumed agent's message task stopped and notifies killed", async () => {
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, "");
		const record: AgentRunRecord = { taskId: "persistent-id", name: "worker", agent: "general-purpose", cwd: dir, sessionFile, sessionSearchDir: dir };
		let finish!: (value: ChildOutcome) => void;
		const handle = {
			result: new Promise<ChildOutcome>((resolve) => { finish = resolve; }),
			kill: vi.fn(() => finish(outcome())),
			snapshot: () => ({ text: "Agent output", toolCalls: 0, usage: emptyUsage() }),
		};
		vi.spyOn(SubagentRuntime, "create").mockResolvedValue({ run: () => handle } as unknown as SubagentRuntime);
		const h = await mount([record]);
		const reply = await h.call("SendMessage", { to: record.taskId, message: "Continue" }) as { details: { taskId: string } };
		await h.call("task_stop", { task_id: reply.details.taskId });
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		expect(handle.kill).toHaveBeenCalledOnce();
		expect(h.tasks.get(reply.details.taskId)?.status).toBe("stopped");
		expect(h.messages()).toContain("<status>killed</status>");
		expect(h.messages()).not.toContain("[Subagent hand-back]");
	});
});

// SUBAGENTS-WORKFLOWS-REVIEW-2026-09-26 M1: a long report is persisted with a
// pointer at every delivery site, never cut.
describe("subagent reports past the cap", () => {
	const longReport = `${"row\n".repeat(17_500)}Verdict: the migration is safe.`;
	const longOutcome = (): ChildOutcome => ({ ...outcome(), output: longReport });
	/** The persisted file a <persisted-output> block names, read back. */
	const persistedText = (text: string) => {
		const path = /Full output saved to: (\S+\.txt)/.exec(text)?.[1];
		expect(path).toBeDefined();
		return readFileSync(path!, "utf-8");
	};

	it("persists a one-shot run's inline report", async () => {
		vi.spyOn(SubagentRuntime, "create").mockResolvedValue({
			run: () => ({ result: Promise.resolve(longOutcome()), kill: vi.fn(), snapshot: () => ({ text: "", toolCalls: 0, usage: emptyUsage() }) }),
		} as unknown as SubagentRuntime);
		const h = await mount([], session, "print");
		const result = (await h.call("Agent", { subagent_type: "general-purpose", task: "Tabulate" })) as { content: Array<{ text: string }> };
		const text = result.content[0].text;
		expect(text).toContain("<persisted-output>");
		expect(text).not.toContain("Verdict:");
		expect(persistedText(text)).toBe(longReport);
	});

	it("persists a resident's hand-back report", async () => {
		const runtime = fakeResident();
		const h = await mount();
		await h.call("Agent", { subagent_type: "general-purpose", task: "Tabulate" });
		runtime.finish([], longReport);
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS + 1);
		const textOf = (content: unknown) =>
			typeof content === "string" ? content : (content as Array<{ text?: string }>).map((block) => block.text ?? "").join("");
		const handBack = h.fake.sentMessages.map((m) => textOf(m.message.content)).find((text) => text.includes("<persisted-output>"));
		expect(handBack).toBeDefined();
		expect(persistedText(handBack!)).toBe(longReport);
	});

	it("persists a nested run's report", async () => {
		const runtime = fakeResident();
		runtime.runner.run.mockReturnValue({ result: Promise.resolve(longOutcome()), kill: vi.fn(), snapshot: () => ({ text: "", toolCalls: 0, usage: emptyUsage() }) });
		const h = await mount();
		h.fake.events.emit(SUBAGENT_GATE_CHANNEL, { decide: async () => undefined });
		await h.call("Agent", { subagent_type: "general-purpose", task: "Delegate the table" });
		const nested = runtime.options().extraTools?.find((tool) => tool.name === "Agent");
		const result = (await nested!.execute("nested-call", { subagent_type: "explore", task: "Tabulate" }, undefined, undefined, h.ctx as never)) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0].text).toContain("<persisted-output>");
		expect(persistedText(result.content[0].text)).toBe(longReport);
	});
});

function fakeResident(failed = false, stoppedActions: ChildOutcome["actions"] = []) {
	let options: Parameters<SubagentRuntime["runResident"]>[0];
	let busy = false;
	let exited = false;
	const finish = (actions: ChildOutcome["actions"] = [], output?: string) => {
		if (!busy) return;
		busy = false;
		options.onTurnEnd?.({ ...outcome(failed), actions, ...(output === undefined ? {} : { output }) });
	};
	const handle = {
		send: vi.fn(async () => { busy = true; return "started" as const; }),
		busy: () => busy,
		exited: () => exited,
		snapshot: () => ({ text: "Agent output", toolCalls: 0, usage: emptyUsage() }),
		release: vi.fn(),
		kill: vi.fn(async () => { if (exited) return; finish(stoppedActions); exited = true; options.onExit?.(); }),
	};
	const runner = {
		runResident: async (opts: typeof options) => { options = opts; return handle; },
		run: vi.fn<SubagentRuntime["run"]>(),
	};
	vi.spyOn(SubagentRuntime, "create").mockResolvedValue(runner as unknown as SubagentRuntime);
	return { handle, finish, runner, options: () => options };
}
