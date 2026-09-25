/**
 * background/index.ts wiring (T15d): the monitor tool's event batching (a real
 * child process, no fake timers needed — a monitor whose command finishes
 * flushes its pending batch synchronously, so the cap/overflow reporting is
 * observable without waiting out MONITOR_BATCH_IDLE_MS), task_stop/task_output
 * around a still-running task, and the /loop, schedule_wakeup and cron
 * timers (fake timers, no external process).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Cron job ids feed Claude Code's jitter (cron.ts JITTER); ids whose first 8 hex
// digits are ~0 keep these fire times exact. The jitter itself is cron.test.ts's.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	let n = 0;
	return { ...actual, randomUUID: () => `${(++n).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` };
});
import backgroundExtension from "../../extensions/background/index.ts";
import { MONITOR_BATCH_MAX_LINES } from "../../extensions/background/monitor-batch.ts";
import { DEFAULT_COALESCE_MS, NOTIFICATION_ID_KEY } from "../../extensions/lib/notifications.ts";
import { SESSION_WORK_CHANNEL, type SessionWorkQuery } from "../../extensions/lib/session-work.ts";
import { AGENT_CRON_CHANNEL, AGENT_CRON_FIRE_CHANNEL, type AgentCronFire, type AgentCronRequest } from "../../extensions/lib/agent-cron.ts";
import { SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../../extensions/lib/skill-body.ts";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/skill-scan.ts";
import { join } from "node:path";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

function mount(): FakePi {
	const fake = createFakePi();
	backgroundExtension(fake.pi as never);
	// An established session: a prompt() has run, so notifications take the
	// custom-message path (before the first prompt they go out as a user message
	// — createTaskNotifier, STEERING-REVIEW-2026-09-05 H1).
	void fake.fire("before_agent_start", {}, createFakeCtx({}));
	return fake;
}

/**
 * A ctx for a session that outlives the turn (the TUI): the monitor detaches
 * there. The fake's default mode is "print", a one-shot, where the monitor now
 * runs to its end inside the tool call (LIFECYCLE-REVIEW-2026-09-06 M3).
 */
const liveSessionCtx = (overrides: Record<string, unknown> = {}) => createFakeCtx({ hasUI: true, mode: "tui", ...overrides });

describe("background wiring: monitor batching", () => {
	it("flushes a batch (capped, with overflow count) as soon as the command exits", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const monitor = fake.tools.get("monitor")!;
		const lineCount = MONITOR_BATCH_MAX_LINES + 10;
		const start = (await monitor.execute(
			"c1",
			{ command: `for i in $(seq 1 ${lineCount}); do echo line$i; done`, description: "many lines" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		const taskId = start.details.taskId;

		// Wait for the notifier to deliver (real timers): the batch and the
		// completion arrive together, so they merge into one message after the
		// coalescing window. (Not task_output: reading a finished task's output
		// withdraws its pending notification — see the next test.)
		for (let waited = 0; fake.sentMessages.length === 0 && waited < 5000; waited += 50) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));

		// CC's mid-run monitor batch: `Monitor event: "…"` with the lines in <event>.
		const batchMessage = fake.sentMessages.find((m) => {
			const text = (m.message.content as Array<{ text?: string }>)[0]?.text ?? "";
			return text.includes('<summary>Monitor event: "many lines"</summary>');
		});
		expect(batchMessage).toBeDefined();
		const batchText = (batchMessage!.message.content as Array<{ text: string }>)[0].text;
		expect(batchText).toContain(`+10 more line(s) not shown — task_output ${taskId} has the full stream`);
		expect(batchText).toContain(`<task-id>${taskId}</task-id>\n<summary>Monitor event`); // no <status> on a batch

		// CC's monitor end: status + the ended summary, the recent tail in <event>.
		const completion = fake.sentMessages.find((m) => {
			const text = (m.message.content as Array<{ text?: string }>)[0]?.text ?? "";
			return text.includes("<status>completed</status>") && text.includes('<summary>Monitor "many lines" stream ended</summary>');
		});
		expect(completion).toBeDefined();
		// Coalesced (STEERING-REVIEW-2026-09-05 M1): one custom message carries both.
		expect(completion).toBe(batchMessage);
		expect(fake.sentMessages).toHaveLength(1);
		// Delivery policy: steered mid-turn, and able to start a turn on its own.
		expect(batchMessage!.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	});

	it("a monitor's end is withheld when task_output already returned its finished output", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const monitor = fake.tools.get("monitor")!;
		const start = (await monitor.execute("c1", { command: "echo one; echo two", description: "short" }, undefined, undefined, ctx)) as {
			details: { taskId: string };
		};
		const taskOutput = fake.tools.get("task_output")!;
		const result = (await taskOutput.execute("c2", { task_id: start.details.taskId, block: true, timeout: 5000 }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0].text).toContain("two");
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));
		expect(fake.sentMessages.filter((m) => m.message.customType === "task-notification")).toHaveLength(0);
	});

	it("task_stop ends a still-running monitor; task_output then reports it stopped", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const monitor = fake.tools.get("monitor")!;
		const start = (await monitor.execute(
			"c1",
			{ command: "sleep 30", description: "long runner" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		const taskId = start.details.taskId;

		const taskStop = fake.tools.get("task_stop")!;
		const stopResult = (await taskStop.execute("c2", { task_id: taskId }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(stopResult.content[0].text).toContain("Stop requested");

		const taskOutput = fake.tools.get("task_output")!;
		const outputResult = (await taskOutput.execute("c3", { task_id: taskId, block: true, timeout: 5000 }, undefined, undefined, ctx)) as {
			details: { status: string };
		};
		expect(outputResult.details.status).toBe("stopped");
	});

	it("task_output/task_stop report a clear error for an unknown task id", async () => {
		const fake = mount();
		const ctx = createFakeCtx({ hasUI: true });
		const result = (await fake.tools.get("task_output")!.execute("c1", { task_id: "nope" }, undefined, undefined, ctx)) as {
			isError: boolean;
			content: Array<{ text: string }>;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('No background task "nope"');
	});
});

describe("background wiring: schedule_wakeup (Claude Code's dynamic loop)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const wake = (fake: FakePi, params: Record<string, unknown>, ctx: unknown) =>
		fake.tools.get("schedule_wakeup")!.execute("c", params, undefined, undefined, ctx) as Promise<{ content: Array<{ text: string }>; isError?: boolean; details: Record<string, unknown> }>;
	const wakeups = (fake: FakePi) => fake.sentMessages.filter((m) => m.message.customType === "wakeup");

	it("fires the prompt verbatim after the clamped delay, lists as a one-shot job, and says when it was clamped", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		const ctx = liveSessionCtx();
		const scheduled = await wake(fake, { delaySeconds: 5, prompt: "check the build", reason: "quick poll", noop: false }, ctx);
		expect(scheduled.content[0].text).toMatch(
			/^Next wakeup scheduled for 12:01:00 \(in 60s\) \(clamped to 60s from your requested value\)\. Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives\.$/,
		);
		const listed = await fake.tools.get("cron_list")!.execute("c", {}, undefined, undefined, ctx) as { content: Array<{ text: string }> };
		expect(listed.content[0].text).toMatch(/^[0-9a-f]{8} — Every day at 12:01 PM \(one-shot\) \[session-only\]: check the build$/);

		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		expect(wakeups(fake)).toHaveLength(1);
		expect((wakeups(fake)[0].message.content as Array<{ text: string }>)[0].text).toBe("check the build");
	});

	it("rejects a call missing a field with Claude Code's errors, and keeps a pending wakeup", async () => {
		vi.useFakeTimers();
		const fake = mount();
		const ctx = liveSessionCtx();
		await wake(fake, { delaySeconds: 120, prompt: "task", reason: "r", noop: true }, ctx);
		const noReason = await wake(fake, { delaySeconds: 60, prompt: "p", noop: true }, ctx);
		expect(noReason).toMatchObject({ isError: true, content: [{ text: "`delaySeconds` and `reason` are required when `stop` is not true." }] });
		const noPrompt = await wake(fake, { delaySeconds: 60, reason: "r", noop: true }, ctx);
		expect(noPrompt.content[0].text).toBe("`prompt` is required when `stop` is not true.");
		const noNoop = await wake(fake, { delaySeconds: 60, reason: "r", prompt: "p" }, ctx);
		expect(noNoop.content[0].text).toBe("`noop` is required when `stop` is not true.");
		await vi.advanceTimersByTimeAsync(120_000 + DEFAULT_COALESCE_MS);
		expect(wakeups(fake)).toHaveLength(1);
	});

	it("keeps one wakeup pending (a new one supersedes it) and stop cancels it with Claude Code's text", async () => {
		vi.useFakeTimers();
		const fake = mount();
		const ctx = liveSessionCtx();
		await wake(fake, { delaySeconds: 60, prompt: "first", reason: "r", noop: false }, ctx);
		await wake(fake, { delaySeconds: 120, prompt: "second", reason: "r", noop: false }, ctx);
		const stopped = await wake(fake, { stop: true }, ctx);
		expect(stopped.content[0].text).toBe(
			"Loop stopped — cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled. If you armed a monitor for this loop, task_stop it now; otherwise nothing more to do this turn.",
		);
		const again = await wake(fake, { stop: true }, ctx);
		expect(again.content[0].text).toContain("there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with cron_delete.");
		await vi.advanceTimersByTimeAsync(300_000);
		expect(wakeups(fake)).toHaveLength(0);
	});

	it("folds a no-op tick into the next wakeup: the streak rides the message, the context drops the tick", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		const firstFire = Date.UTC(2026, 8, 25, 6, 29, 0);
		const branch = [
			{ type: "custom_message", customType: "wakeup", timestamp: new Date(firstFire).toISOString(), details: {} },
			{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "schedule_wakeup", arguments: { noop: true } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1", content: [] } },
		];
		const ctx = liveSessionCtx({ sessionManager: { getBranch: () => branch } });
		await wake(fake, { delaySeconds: 60, prompt: "/loop poll", reason: "r", noop: true }, ctx);
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		const fired = wakeups(fake)[0];
		expect(fired.message.details).toMatchObject({ noOpStreak: 1, streakStartedAt: firstFire });

		const context = [
			{ role: "user", content: "start", timestamp: 1 },
			{ role: "custom", customType: "wakeup", content: "/loop poll", details: {}, timestamp: 2 },
			{ role: "assistant", content: [], timestamp: 3 },
			{ role: "custom", customType: "wakeup", content: "/loop poll", details: { noOpStreak: 1 }, timestamp: 4 },
		];
		const [answer] = await fake.fire<{ messages: Array<{ role: string; content: unknown }> }>("context", { messages: context });
		expect(answer.messages.map((m) => m.role)).toEqual(["user", "user", "custom"]);
		expect(answer.messages[1].content).toEqual([{ type: "text", text: "[1 prior /loop wakeup found nothing actionable; loop is healthy.]" }]);
	});

	it("keepalive: a wakeup's turn that schedules nothing gets one 1200 s fallback; a second miss ends the loop", async () => {
		vi.useFakeTimers();
		const fake = mount();
		const ctx = liveSessionCtx();
		const confirmPending = confirmer(fake);
		await wake(fake, { delaySeconds: 60, prompt: "/loop check the deploy", reason: "r", noop: false }, ctx);
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		await confirmPending();
		expect(wakeups(fake)).toHaveLength(1);

		// The fired turn runs and ends without calling schedule_wakeup.
		await fake.fireOne("agent_start", {});
		await fake.fireOne("agent_settled", {});
		await vi.advanceTimersByTimeAsync(1_199_000);
		expect(wakeups(fake)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_000 + DEFAULT_COALESCE_MS);
		await confirmPending();
		expect(wakeups(fake)).toHaveLength(2);

		// It misses again: the budget is spent, nothing is re-armed.
		await fake.fireOne("agent_start", {});
		await fake.fireOne("agent_settled", {});
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(wakeups(fake)).toHaveLength(2);
	});
});

/** Confirm each notification as it lands, as pi's delivery loop does, so agent_settled tests the scheduler and not a resend. */
function confirmer(fake: FakePi) {
	let confirmed = 0;
	return async () => {
		for (; confirmed < fake.sentMessages.length; confirmed++) {
			const details = fake.sentMessages[confirmed].message.details as Record<string, unknown> | undefined;
			if (details?.[NOTIFICATION_ID_KEY]) await fake.fireOne("message_end", { message: { role: "custom", details } });
		}
	};
}

type ToolResult = { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };

describe("background wiring: cron tools", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const cronCall = (fake: FakePi, name: string, params: Record<string, unknown>, ctx: unknown) =>
		fake.tools.get(name)!.execute("c", params, undefined, undefined, ctx) as Promise<ToolResult>;
	const cronFires = (fake: FakePi) => fake.sentMessages.filter((m) => m.message.customType === "cron");

	it("a one-shot fires its prompt verbatim at the match while idle, then is gone", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 14, 28, 0));
		const fake = mount();
		const ctx = liveSessionCtx();
		const created = await cronCall(fake, "cron_create", { cron: "30 14 25 9 *", prompt: "check the deploy", recurring: false }, ctx);
		expect(created.content[0].text).toMatch(
			/^Scheduled one-shot task [0-9a-f]{8} \(30 14 25 9 \*\)\. Session-only \(not written to disk, dies when this session ends\)\. It will fire once then auto-delete\.$/,
		);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(cronFires(fake)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		expect(cronFires(fake)).toHaveLength(1);
		const fire = cronFires(fake)[0];
		expect((fire.message.content as Array<{ text: string }>)[0].text).toBe("check the deploy");
		expect(fire.message.details).toMatchObject({ jobId: created.details.jobId, final: true, source: "model" });

		expect((await cronCall(fake, "cron_list", {}, ctx)).content[0].text).toBe("No scheduled jobs.");
	});

	it("a recurring job due during a turn fires once at settle, and re-arms for its next match", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		const ctx = liveSessionCtx();
		const confirmPending = confirmer(fake);
		const created = await cronCall(fake, "cron_create", { cron: "*/10 * * * *", prompt: "poll ci" }, ctx);
		expect(created.content[0].text).toContain("(Every 10 minutes). Session-only");
		expect(created.content[0].text).toContain("Auto-expires after 7 days. Use cron_delete to cancel sooner.");

		await fake.fireOne("agent_start", {});
		await vi.advanceTimersByTimeAsync(16 * 60_000);
		expect(cronFires(fake)).toHaveLength(0);
		await fake.fireOne("agent_settled", {});
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);
		await confirmPending();
		expect(cronFires(fake)).toHaveLength(1);

		// Next match is 12:20; nothing fires before it.
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(cronFires(fake)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		expect(cronFires(fake)).toHaveLength(2);
	});

	it("errors fail loud: a bad expression, an unknown id", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const bad = await cronCall(fake, "cron_create", { cron: "every 5 minutes", prompt: "x" }, ctx);
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toBe("Invalid cron expression 'every 5 minutes'. Expected 5 fields: M H DoM Mon DoW.");
		const unknown = await cronCall(fake, "cron_delete", { id: "deadbeef" }, ctx);
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toBe("No scheduled job with id 'deadbeef'");
	});

	it("in a one-shot mode the job is created but the result says it can never fire", async () => {
		const fake = mount();
		const created = await cronCall(fake, "cron_create", { cron: "*/5 * * * *", prompt: "x" }, createFakeCtx({ mode: "print" }));
		expect(created.isError).toBeFalsy();
		expect(created.content[0].text).toContain("This is a one-shot session: it ends when this turn does, so the job will never fire.");
	});

	it("accepts `durable` and ignores it, as Claude Code does with its durable mode off", async () => {
		const fake = mount();
		const schema = fake.tools.get("cron_create")!.parameters as { properties: Record<string, { description?: string }> };
		expect(schema.properties.durable.description).toBe("Has no effect — durable persistence is not available. All jobs are session-only (in-memory, gone when this session ends).");
		const created = await cronCall(fake, "cron_create", { cron: "*/10 * * * *", prompt: "x", durable: true }, liveSessionCtx());
		expect(created.content[0].text).toContain("Session-only (not written to disk, dies when this session ends)");
	});

	it("builds /loop's body for our bundled SKILL.md only", () => {
		const fake = mount();
		const ours: SkillBodyQuery = { skill: "loop", path: join(BUNDLED_SKILLS_DIR, "loop", "SKILL.md"), args: "5m check CI", cwd: "/nowhere" };
		fake.events.emit(SKILL_BODY_CHANNEL, ours);
		expect(ours.body).toContain("# /loop — schedule a recurring or self-paced prompt");
		expect(ours.body?.endsWith("## Input\n\n5m check CI")).toBe(true);
		const theirs: SkillBodyQuery = { skill: "loop", path: "/project/.claude/skills/loop/SKILL.md", args: "x", cwd: "/nowhere" };
		fake.events.emit(SKILL_BODY_CHANNEL, theirs);
		expect(theirs.body).toBeUndefined();
	});

	it("runs a fired slash command as the skill it names, and expands a no-prompt sentinel", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		fake.events.on(SLASH_EXPAND_CHANNEL, (data) => {
			const query = data as SlashExpandQuery;
			if (query.text === "/babysit-prs") query.expanded = "<skill name=\"babysit-prs\">…</skill>";
		});
		const ctx = liveSessionCtx();
		await cronCall(fake, "cron_create", { cron: "1 12 * * *", prompt: "/babysit-prs", recurring: false }, ctx);
		await cronCall(fake, "cron_create", { cron: "2 12 * * *", prompt: "<<autonomous-loop>>", recurring: false }, ctx);
		const confirmPending = confirmer(fake);
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		await confirmPending();
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		const texts = cronFires(fake).map((m) => (m.message.content as Array<{ text: string }>)[0].text);
		expect(texts[0]).toBe('<skill name="babysit-prs">…</skill>');
		expect(texts[1].startsWith("# Autonomous loop check")).toBe(true);
		expect(texts[1]).toContain("\n\n---\n\n# Autonomous loop tick");
	});

	it("keeps a subagent's jobs its own: tagged, listed and deletable only by it, fired to it or dropped", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		const ctx = liveSessionCtx();
		const ask = (request: AgentCronRequest) => {
			fake.events.emit(AGENT_CRON_CHANNEL, request);
			return request.result!;
		};
		const created = ask({ op: "create", agentId: "a1", cwd: "/project", cron: "1 12 * * *", prompt: "agent check", recurring: false });
		expect(created.text).toMatch(/^Scheduled one-shot task [0-9a-f]{8} /);
		const jobId = created.details!.jobId as string;
		await cronCall(fake, "cron_create", { cron: "*/10 * * * *", prompt: "main job" }, ctx);

		expect(ask({ op: "list", agentId: "a1" }).text).toBe(`${jobId} — Every day at 12:01 PM (one-shot) [session-only]: agent check`);
		expect(ask({ op: "list", agentId: "a2" }).text).toBe("No scheduled jobs.");
		// The main session sees every job.
		expect((await cronCall(fake, "cron_list", {}, ctx)).content[0].text.split("\n")).toHaveLength(2);
		expect(ask({ op: "delete", agentId: "a2", id: jobId })).toEqual({ text: `Cannot delete cron job '${jobId}': owned by another agent`, isError: true });

		const fires: AgentCronFire[] = [];
		fake.events.on(AGENT_CRON_FIRE_CHANNEL, (data) => fires.push(data as AgentCronFire));
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		expect(fires).toMatchObject([{ agentId: "a1", jobId, prompt: "agent check" }]);
		// Nothing reached the main conversation.
		expect(cronFires(fake)).toHaveLength(0);
	});

	it("resolves a fired prompt in its owner's directory: the agent's, the main worktree, or the session's", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		await fake.fire("session_start", {}, liveSessionCtx({ cwd: "/project" }));
		const cwds: Record<string, string> = {};
		fake.events.on(SLASH_EXPAND_CHANNEL, (data) => {
			const query = data as SlashExpandQuery;
			cwds[query.text] = query.cwd;
		});
		const ctx = liveSessionCtx({ cwd: "/project" });
		await cronCall(fake, "cron_create", { cron: "1 12 * * *", prompt: "/main-before", recurring: false }, ctx);
		fake.events.emit(AGENT_CRON_CHANNEL, { op: "create", agentId: "a1", cwd: "/agent-tree", cron: "1 12 * * *", prompt: "/agent", recurring: false } satisfies AgentCronRequest);
		await cronCall(fake, "cron_create", { cron: "2 12 * * *", prompt: "/main-in-worktree", recurring: false }, ctx);
		await cronCall(fake, "cron_create", { cron: "3 12 * * *", prompt: "/main-after", recurring: false }, ctx);

		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		fake.events.emit(WORKTREE_CHANNEL, { path: "/project-wt", branch: "wt" });
		await vi.advanceTimersByTimeAsync(60_000);
		fake.events.emit(WORKTREE_CHANNEL, null);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(cwds).toEqual({ "/main-before": "/project", "/agent": "/agent-tree", "/main-in-worktree": "/project-wt", "/main-after": "/project" });
	});

	it("drops a recurring job whose agent has ended", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		const request: AgentCronRequest = { op: "create", agentId: "gone", cwd: "/project", cron: "*/10 * * * *", prompt: "tick" };
		fake.events.emit(AGENT_CRON_CHANNEL, request);
		await vi.advanceTimersByTimeAsync(10 * 60_000 + DEFAULT_COALESCE_MS);
		const list: AgentCronRequest = { op: "list", agentId: "gone" };
		fake.events.emit(AGENT_CRON_CHANNEL, list);
		expect(list.result!.text).toBe("No scheduled jobs.");
	});

	it("answers the Stop hook's query with its pending jobs", async () => {
		const fake = mount();
		const created = await cronCall(fake, "cron_create", { cron: "*/10 * * * *", prompt: "poll" }, liveSessionCtx());
		const query: SessionWorkQuery = { crons: [], tasks: [] };
		fake.events.emit(SESSION_WORK_CHANNEL, query);
		expect(query.crons).toEqual([{ id: created.details.jobId, schedule: "*/10 * * * *", recurring: true, prompt: "poll" }]);
		expect(query.tasks).toEqual([]);
	});

	it("/clear cancels every job and says so in the next session; nothing fires afterwards", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 25, 12, 0, 0));
		const fake = mount();
		const ctx = liveSessionCtx();
		const created = await cronCall(fake, "cron_create", { cron: "*/5 * * * *", prompt: "x" }, ctx);
		await fake.fire("session_shutdown", { reason: "new" }, ctx);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(cronFires(fake)).toHaveLength(0);
		const notify = await freshSessionNotify("new");
		expect(notify.mock.calls[0][0]).toBe(`Cancelled 1 scheduled job with the previous session: ${created.details.jobId} (Every 5 minutes).`);
	});
});

/** Mount a fresh instance (the factory re-run after a session swap), start it with a UI, and return its notify mock. */
async function freshSessionNotify(reason: string) {
	const next = createFakePi();
	backgroundExtension(next.pi as never);
	const notify = vi.fn();
	await next.fire("session_start", { reason }, createFakeCtx({ hasUI: true, mode: "tui", ui: { notify } }));
	return notify;
}

describe("background wiring: monitor lifecycle (LIFECYCLE-REVIEW-2026-09-06)", () => {
	it("H1: a monitor whose command ends after session_shutdown repaints nothing, notifies nothing, and never throws", async () => {
		const fake = mount();
		const setWidget = vi.fn();
		const ctx = liveSessionCtx({ ui: { setWidget } });
		const start = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30; echo done", description: "outlives the session" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		expect(setWidget).toHaveBeenCalledTimes(1);
		fake.sentMessages.length = 0;

		await fake.fire("session_shutdown", { reason: "new" }, ctx);
		// From here every getter on the old ctx throws, as pi's does after dispose.
		Object.defineProperty(ctx, "hasUI", {
			get() {
				throw new Error("This extension ctx is stale after session replacement");
			},
		});
		// stopAll SIGTERMed the tree; its `close` lands after shutdown. Wait for it
		// through task_output on a fresh (post-swap) ctx — must not throw either.
		const out = (await fake.tools.get("task_output")!.execute(
			"c2",
			{ task_id: start.details.taskId, block: true, timeout: 5000 },
			undefined,
			undefined,
			createFakeCtx({ mode: "tui" }),
		)) as { details: { status: string } };
		expect(out.details.status).toBe("stopped");
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));
		expect(setWidget).toHaveBeenCalledTimes(1); // no repaint after shutdown
		expect(fake.sentMessages).toHaveLength(0); // no completion notification
	});

	it("M2: task_stop ends the monitored command itself (a `cmd; echo` sequence), so the task finishes at once", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const start = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30; echo done", description: "sequence" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		await new Promise((resolve) => setTimeout(resolve, 100)); // let the shell fork `sleep`
		const stopped = Date.now();
		await fake.tools.get("task_stop")!.execute("c2", { task_id: start.details.taskId }, undefined, undefined, ctx);
		const out = (await fake.tools.get("task_output")!.execute(
			"c3",
			{ task_id: start.details.taskId, block: true, timeout: 5000 },
			undefined,
			undefined,
			ctx,
		)) as { details: { status: string } };
		expect(out.details.status).toBe("stopped");
		// Killing only the shell left `sleep 30` holding the pipe: close came 30 s later.
		expect(Date.now() - stopped).toBeLessThan(3000);
	});

	it("M3: in a one-shot mode the monitor runs to its end and returns the events in the result, registering nothing", async () => {
		const fake = mount();
		const ctx = createFakeCtx({ mode: "print" });
		const result = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "echo ev1; echo ev2; echo ev3", description: "one-shot" },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };
		const text = result.content[0].text;
		expect(text).toContain("completed after 3 event(s)");
		expect(text).toContain("This is a one-shot session, so the monitor ran to completion instead of in the background.");
		expect(text).toContain("ev1\nev2\nev3");
		expect(result.isError).toBeFalsy();
		expect(result.details.taskId).toBeUndefined();
		// Nothing addressable afterwards, and no notification ever queued.
		const lookup = (await fake.tools.get("task_output")!.execute("c2", { task_id: "anything" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(lookup.content[0].text).toContain("Known tasks: (none)");
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));
		expect(fake.sentMessages).toHaveLength(0);
	});

	it("M3: a one-shot monitor stops when the tool call is aborted and says so", async () => {
		const fake = mount();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const result = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30; echo done", description: "aborted" },
			controller.signal,
			undefined,
			createFakeCtx({ mode: "json" }),
		)) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("stopped (tool call aborted) after 0 event(s)");
	});

	it("L3: /clear reports the tasks it stopped in the NEXT session, not the one being torn down", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const start = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30", description: "dev server" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		await fake.fire("session_shutdown", { reason: "new" }, ctx);

		// The replacement instance (factories re-run on /clear, findings §8).
		const notify = await freshSessionNotify("new");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain(`Stopped 1 background task with the previous session: ${start.details.taskId} (dev server).`);

		// Consumed: a further session start says nothing.
		expect(await freshSessionNotify("new")).not.toHaveBeenCalled();
	});

	it("L3: a quit leaves no notice behind", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		await fake.tools.get("monitor")!.execute("c1", { command: "sleep 30", description: "x" }, undefined, undefined, ctx);
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
		expect(await freshSessionNotify("startup")).not.toHaveBeenCalled();
	});
});
