/**
 * background extension — Claude Code's background-task surface:
 * monitor, task_output, task_stop, schedule_wakeup, cron_create, cron_list,
 * cron_delete, and /loop.
 *
 * Owns the BackgroundRegistry. Other extensions (subagents) register their
 * long-running work over TASK_REGISTER_CHANNEL at runtime, so task_output and
 * task_stop address every background task in the session regardless of which
 * extension started it. Events and completions are delivered as steered
 * task notifications (lib/notifications.ts), never as user input; a fired
 * wakeup or cron job re-invokes the session with its prompt verbatim.
 *
 * Every scheduled prompt lives in one CronStore (cron.ts): cron_create jobs
 * and schedule_wakeup's one-shot wakeups (wakeup.ts). One timer is armed to
 * the store's next fire; jobs fire only while the agent is idle, so a job
 * that came due during a turn fires once at agent_settled. `/loop` is
 * Claude Code's skill (skills/loop, its body built by loop-skill.ts): the
 * model schedules the loop itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { whenAborted } from "../lib/abort.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { detachedSpawnOptions, KILL_GRACE_MS, stopProcessTree, waitForChildExit } from "../lib/process-tree.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { bashSpawn, spawnShellCommand } from "../lib/shell-spawn.ts";
import { ccToolRenderers, customMessageText, formatFireTime, liveUiCtx, notificationComponent, scheduledTaskComponent } from "../lib/tui-render.ts";
import {
	type BackgroundTask,
	BackgroundRegistry,
	formatTaskLine,
	generateTaskId,
	TASK_REGISTER_CHANNEL,
} from "./registry.ts";
import {
	AGED_OUT_RESULT,
	DynamicLoop,
	formatScheduled,
	formatStopped,
	SCHEDULE_WAKEUP_DESCRIPTION,
	SCHEDULE_WAKEUP_PARAMS,
	WAKEUP_ERRORS,
} from "./wakeup.ts";
import { freshDeliveryState, readLoopFile, resolveLoopFire } from "./loop-fire.ts";
import { autonomousPreamble, loopSkillPrompt } from "./loop-skill.ts";
import {
	CRON_CREATE_DESCRIPTION,
	CRON_CREATE_PARAMETERS,
	CRON_DELETE_DESCRIPTION,
	CRON_DELETE_PARAMETERS,
	CRON_LIST_DESCRIPTION,
	CRON_LIST_PARAMETERS,
	CronStore,
	type CronFire,
	type CronJob,
	describeCadence,
	formatCannotFire,
	formatCreateResult,
	formatDeleteResult,
	formatJobList,
	formatUnknownJob,
} from "./cron.ts";
import {
	createTaskNotifier,
	monitorEndedSummary,
	monitorEventSummary,
	oneShotNote,
	sessionOutlivesTurn,
	TASK_OUTPUT_DELIVERED_CHANNEL,
	type TaskOutputDelivered,
	taskNotification,
	taskStatusOf,
} from "../lib/notifications.ts";
import {
	batchSize,
	emptyBatch,
	formatMonitorEvents,
	MONITOR_BATCH_BUSY_MS,
	MONITOR_BATCH_MAX_CHARS,
	MONITOR_BATCH_IDLE_MS,
	type MonitorBatch,
	pushEvent,
} from "./monitor-batch.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { applyNoopFolds, decideFold, type FoldDetails, type FoldEntry, foldSuffix } from "./noop-fold.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AGENT_CRON_CHANNEL, AGENT_CRON_FIRE_CHANNEL, type AgentCronFire, type AgentCronRequest, formatNotOwner } from "../lib/agent-cron.ts";
import { SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../lib/skill-body.ts";
import { BUNDLED_SKILLS_DIR } from "../lib/skill-scan.ts";
import { join, resolve } from "node:path";
import { SESSION_WORK_CHANNEL, sessionBackgroundTask, sessionCron, type SessionWorkQuery } from "../lib/session-work.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";

const OUTPUT_CAP = 30_000;
const STORED_OUTPUT_CAP = 200_000;
const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
const MAX_MONITOR_TIMEOUT_MS = 3_600_000;
const MAX_BLOCK_TIMEOUT_MS = 600_000;
/** setTimeout's longest delay; a later fire re-arms when this one wakes. */
const MAX_TIMER_MS = 2 ** 31 - 1;
function tail(text: string, cap: number): string {
	return text.length <= cap ? text : `… (earlier output truncated)\n${text.slice(-cap)}`;
}

/**
 * `/clear`, `/new` and `/resume` stop every background task with the session
 * they belong to (the notifier that would report them is inert by then, and
 * the new session has no handle on them). Say so, once, in the NEW session:
 * the old session's UI is torn down right after `session_shutdown`, so a
 * notice printed there is lost. Module scope on purpose — jiti keeps this
 * module across the factory re-run that builds the new instance, which is the
 * only thing that survives the swap (LIFECYCLE-REVIEW-2026-09-06 L3).
 */
let pendingShutdownNotice: string | undefined;

/** A session entry as the no-op fold reads it (noop-fold.ts). */
function foldEntry(entry: { type: string; timestamp?: string; customType?: string; details?: unknown; message?: unknown }): FoldEntry {
	if (entry.type === "compaction") return { kind: "compaction" };
	if (entry.type === "custom_message") {
		if (entry.customType === "wakeup") return { kind: "wakeup", timestamp: Date.parse(entry.timestamp ?? "") || 0, details: entry.details as FoldDetails | undefined };
		return entry.customType === "cron" ? { kind: "fire" } : { kind: "other" };
	}
	if (entry.type !== "message") return { kind: "other" };
	const message = entry.message as { role?: string; content?: unknown; stopReason?: string; toolCallId?: string };
	if (message.role === "user") return { kind: "user" };
	if (message.role === "toolResult") return { kind: "toolResult", toolCallId: message.toolCallId ?? "" };
	if (message.role === "assistant") {
		const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: string; id?: string; name?: string; arguments?: { noop?: unknown } }>) : [];
		const toolCalls = blocks.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id ?? "", name: b.name ?? "", noop: b.arguments?.noop }));
		return { kind: "assistant", toolCalls, aborted: message.stopReason === "aborted" };
	}
	return { kind: "other" };
}

export default function backgroundExtension(pi: ExtensionAPI) {
	// After session_shutdown the captured ctx throws on every access and the
	// notifier is inert; a monitor whose command ends later (its shell was
	// killed, the orphaned command finished) must repaint nothing and say
	// nothing — before this guard, the widget repaint from the child's `close`
	// callback took the whole process down (LIFECYCLE-REVIEW-2026-09-06 H1).
	const alive = sessionAlive(pi);
	const registry = new BackgroundRegistry();
	let lastCtx: ExtensionContext | undefined;
	const cron = new CronStore();
	const dynamicLoop = new DynamicLoop(cron);
	// What the no-prompt /loop sentinels already delivered; compaction resets it (loop-fire.ts).
	let loopDelivery = freshDeliveryState();
	let sessionCwd = process.cwd();
	// The main session's worktree while it is in one (enter_worktree), where its fires resolve.
	let worktreeCwd: string | undefined;
	pi.events.on(WORKTREE_CHANNEL, (data) => {
		worktreeCwd = (data as WorktreeLocation | null)?.path;
	});
	let cronTimer: NodeJS.Timeout | undefined;
	// True between agent_start and agent_settled, so a due cron job waits for the
	// turn to end instead of injecting one mid-run. agent_settled, not agent_end:
	// agent_end can precede an internal retry / auto-compaction / queued
	// continuation, and a fire landing in that gap would inject a turn while the
	// prior one is still about to resume.
	let agentBusy = false;

	pi.events.on(TASK_REGISTER_CHANNEL, (task) => registry.register(task as BackgroundTask));
	// A subagent's cron tools (lib/agent-cron.ts): its jobs, its view, its deletes.
	pi.events.on(AGENT_CRON_CHANNEL, (data) => {
		const request = data as AgentCronRequest;
		if (request.op === "create") {
			const created = cron.create({ cron: request.cron, prompt: request.prompt, recurring: request.recurring, agentId: request.agentId, cwd: request.cwd }, Date.now());
			request.result = created.ok
				? { text: formatCreateResult(created.job), details: { jobId: created.job.id } }
				: { text: created.error, isError: true };
			if (created.ok) runCron();
		} else if (request.op === "list") {
			request.result = { text: formatJobList(cron.list().filter((job) => job.agentId === request.agentId)) };
		} else {
			const job = cron.get(request.id);
			if (!job) request.result = { text: formatUnknownJob(request.id), isError: true };
			else if (job.agentId !== request.agentId) request.result = { text: formatNotOwner(request.id), isError: true };
			else {
				cron.delete(request.id);
				runCron();
				request.result = { text: formatDeleteResult(request.id) };
			}
		}
	});
	// The Stop hook's session_crons / background_tasks (lib/session-work.ts).
	pi.events.on(SESSION_WORK_CHANNEL, (data) => {
		const query = data as SessionWorkQuery;
		query.crons.push(...cron.list().map(sessionCron));
		query.tasks.push(...registry.running().map(sessionBackgroundTask));
	});

	const updateWidget = () => {
		// liveUiCtx: a stale ctx (session replaced) reads as "no UI", never a throw;
		// session_shutdown also drops lastCtx, so a late repaint is a no-op.
		const live = liveUiCtx(lastCtx);
		if (!live) return;
		// A task whose producer gives it first-class panel UI (bash shells and
		// subagent runs in the subagents panel) is excluded, or this line would
		// stay permanently lit next to the panel already showing the same work.
		const running = registry.running().filter((t) => !t.ownUI).length;
		live.ui.setWidget("cc-background", running > 0 ? [` background tasks: ${running} running`] : undefined);
	};

	// The wire frames are model-facing; the transcript shows a compact headline
	// instead (ctrl+o expands). One registration covers every emitter of
	// `task-notification` (bash uses it too). A fired wakeup or loop tick is the
	// prompt verbatim, shown behind Claude Code's "Running scheduled task" line.
	pi.registerMessageRenderer("task-notification", (message, { expanded }, theme) =>
		notificationComponent(theme, customMessageText(message.content), expanded),
	);
	for (const customType of ["wakeup", "cron"]) {
		// Claude Code: "Claude resuming /loop wakeup (…)" for a wakeup; the model here may not be Claude.
		const label = customType === "wakeup" ? "Resuming /loop wakeup" : undefined;
		pi.registerMessageRenderer(customType, (message, { expanded }, theme) => {
			const fold = message.details as FoldDetails | undefined;
			const suffix = fold?.noOpStreak ? foldSuffix(fold.noOpStreak, formatFireTime(fold.streakStartedAt ?? Date.now())) : "";
			return scheduledTaskComponent(theme, customMessageText(message.content), (message as { timestamp?: number }).timestamp ?? Date.now(), expanded, label, suffix);
		});
	}

	// A monitor's end the model already read through task_output is withdrawn
	// like a shell's (lib/notifications.ts).
	const notify = createTaskNotifier(pi, { withdrawOnDelivery: true });

	/**
	 * The text a fired prompt delivers, as Claude Code's queue would run it: a
	 * no-prompt /loop sentinel expands (loop-fire.ts), and a slash command that
	 * names a skill runs that skill (lib/skill-body.ts); anything else is the
	 * prompt verbatim. Both resolve in the job owner's directory: a subagent's
	 * own, or the main session's worktree while it is in one.
	 */
	const fireText = (job: CronJob): string => {
		const { prompt } = job;
		const cwd = job.cwd ?? worktreeCwd ?? sessionCwd;
		const resolved = resolveLoopFire(loopDelivery, prompt, cwd, autonomousPreamble());
		if (resolved !== prompt || !prompt.startsWith("/")) return resolved;
		const query: SlashExpandQuery = { text: prompt, cwd };
		pi.events.emit(SLASH_EXPAND_CHANNEL, query);
		return query.expanded ?? prompt;
	};
	/** Claude Code's no-op fold for the wakeup firing now (noop-fold.ts), read off the session branch. */
	const foldDetails = (): FoldDetails => {
		let entries: FoldEntry[];
		try {
			entries = (lastCtx?.sessionManager.getBranch() ?? []).map(foldEntry);
		} catch {
			return {};
		}
		const decision = decideFold(entries);
		return decision.kind === "fold" ? { noOpStreak: decision.priorStreak + 1, streakStartedAt: decision.since } : {};
	};
	const fireCron = (fire: CronFire) => {
		const { job, final } = fire;
		if (job.agentId !== undefined) {
			// A subagent's job goes to that agent, or is dropped once it has ended.
			const delivery: AgentCronFire = { agentId: job.agentId, jobId: job.id, prompt: fireText(job) };
			pi.events.emit(AGENT_CRON_FIRE_CHANNEL, delivery);
			if (!delivery.delivered) cron.delete(job.id);
			return;
		}
		const fold = job.source === "wakeup" ? foldDetails() : {};
		if (job.source === "wakeup") dynamicLoop.inFlight = job.prompt;
		notify(job.source === "wakeup" ? "wakeup" : "cron", fireText(job), { jobId: job.id, cron: job.cron, source: job.source, final, ...fold });
	};
	/** Fire every due job (only while idle), then arm the one timer to the next fire. */
	const runCron = () => {
		if (cronTimer) clearTimeout(cronTimer);
		cronTimer = undefined;
		// A busy agent re-runs this at agent_settled; a dead session never does.
		if (!alive() || agentBusy) return;
		for (const fire of cron.takeDue(Date.now())) fireCron(fire);
		const next = cron.nextFireAt();
		if (next === undefined) return;
		cronTimer = setTimeout(runCron, Math.min(Math.max(0, next - Date.now()), MAX_TIMER_MS));
		cronTimer.unref?.();
	};

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		...ccToolRenderers("Monitor"),
		description:
			"Start a background monitor that streams events from a long-running command. Each stdout line becomes a notification delivered to the conversation while you keep working; the command exiting ends the watch. Use for 'tell me every time X happens' (tail -f, an until-loop that polls a condition); for a single command's completion prefer bash with run_in_background: true — its completion notification arrives on its own. Returns a task id — stop with task_stop, inspect with task_output (both deferred — load them with tool_search). Alternatively pass `ws` to watch a WebSocket (each text frame is an event).",
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Shell command; each stdout line is an event, exit ends the watch" })),
			description: Type.String({ description: "Short description of what is being monitored (shown in notifications)" }),
			persistent: Type.Optional(Type.Boolean({ description: "Run for the session lifetime (no timeout); stop with task_stop" })),
			timeout_ms: Type.Optional(
				Type.Number({ minimum: 1000, description: `Kill the monitor after this deadline (default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}); ignored when persistent` }),
			),
			ws: Type.Optional(
				Type.Object(
					{
						url: Type.String(),
						protocols: Type.Optional(Type.Array(Type.String())),
					},
					{ description: "WebSocket to watch instead of a command; each text frame is an event, close ends the watch" },
				),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (Boolean(params.command) === Boolean(params.ws)) {
				return {
					content: [{ type: "text", text: "Pass exactly one of `command` or `ws`." }],
					details: {},
					isError: true,
				};
			}

			// One-shot modes (`-p` / `--mode json`) exit when the turn settles: the
			// notifier goes inert, shutdown kills the monitor, and nothing it saw
			// reaches anyone — the tool result had promised "events arrive as
			// notifications" (LIFECYCLE-REVIEW M3, measured). Run it to its end
			// there (exit or deadline) and return the collected events in the
			// result — the shape bash and Agent use in these modes.
			const oneShot = !sessionOutlivesTurn(ctx.mode);
			const id = generateTaskId();
			let status: BackgroundTask["status"] = "running";
			let stored = "";
			let eventCount = 0;
			let pending: MonitorBatch = emptyBatch();
			let flushTimer: NodeJS.Timeout | undefined;
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});

			const flush = () => {
				flushTimer = undefined;
				if (batchSize(pending) === 0) return;
				const batch = pending;
				pending = emptyBatch();
				// CC's mid-run monitor batch: no status, the lines in `<event>`.
				notify(
					"task-notification",
					taskNotification({ kind: "monitor", taskId: id, summary: monitorEventSummary(params.description), result: formatMonitorEvents(id, batch) }),
					{ taskId: id, events: batchSize(batch) },
				);
			};

			const onEvent = (line: string) => {
				eventCount++;
				stored = tail(`${stored}${line}\n`, STORED_OUTPUT_CAP);
				if (oneShot) return; // collected into the tool result instead
				pushEvent(pending, line);
				// Bounded batches, and a wider window mid-turn so a chatty stream
				// coalesces instead of steering one notification per second
				// (monitor-batch.ts).
				flushTimer ??= setTimeout(flush, agentBusy ? MONITOR_BATCH_BUSY_MS : MONITOR_BATCH_IDLE_MS);
			};

			const end = (finalStatus: BackgroundTask["status"], note?: string) => {
				if (status !== "running") return;
				status = finalStatus;
				task.status = finalStatus;
				task.finishedAt = Date.now();
				if (flushTimer) clearTimeout(flushTimer);
				finish();
				// Past this point everything touches the session: a monitor ending
				// after shutdown (H1) or inside a one-shot run reports through
				// `finished` alone.
				if (!alive() || oneShot) return;
				flush();
				updateWidget();
				// CC's monitor end: the recent tail rides `<event>` under the ended summary.
				const ccStatus = taskStatusOf(finalStatus);
				const recent = tail(stored, MONITOR_BATCH_MAX_CHARS).trim();
				notify(
					"task-notification",
					taskNotification({
						kind: "monitor",
						taskId: id,
						toolUseId: toolCallId,
						status: ccStatus,
						summary: monitorEndedSummary(params.description, ccStatus, eventCount > 0, note),
						result: recent || undefined,
					}),
					{ taskId: id, status: finalStatus },
				);
			};

			let stopRequested = false;
			let stop: () => void;
			if (params.command) {
				// Own process group: stop() must end the COMMAND, not just the `$SHELL -c`
				// leader — with zsh a `cmd; echo` or a pipeline otherwise lives on as an
				// orphan holding the stdout pipe, so the task never finishes and, in a
				// one-shot run, the process cannot exit (LIFECYCLE-REVIEW M2, measured).
				// The session's bash (Git Bash on Windows) — lib/shell-spawn.ts.
				const bash = bashSpawn();
				if (!bash.spawn) {
					return {
						content: [{ type: "text", text: `Cannot start the monitor: ${bash.error ?? "no bash shell was found"}` }],
						details: {},
						isError: true,
					};
				}
				const child = spawnShellCommand(bash.spawn, params.command, {
					cwd: ctx.cwd,
					...detachedSpawnOptions(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				let buffer = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					let idx: number;
					while ((idx = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, idx).trimEnd();
						buffer = buffer.slice(idx + 1);
						if (line) onEvent(line);
					}
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stored = tail(`${stored}${chunk.toString()}`, STORED_OUTPUT_CAP);
				});
				// Exit plus a short stdio grace, not `close` (lib/process-tree.ts).
				waitForChildExit(child).then(
					({ code }) =>
						end(
							stopRequested ? "stopped" : code === 0 ? "completed" : "failed",
							code !== null && code !== 0 ? `exit code ${code}` : undefined,
						),
					(error: Error) => end("failed", error.message),
				);
				stop = () => {
					stopRequested = true;
					stopProcessTree(child, KILL_GRACE_MS);
				};
			} else {
				let ws: WebSocket;
				try {
					ws = new WebSocket(params.ws!.url, params.ws!.protocols);
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Could not open the WebSocket — check \`ws.url\` ("${params.ws!.url}"): ${(error as Error).message}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				ws.addEventListener("message", (event) => {
					onEvent(typeof event.data === "string" ? event.data : "[binary frame]");
				});
				ws.addEventListener("error", () => end("failed", "websocket error"));
				ws.addEventListener("close", () => end(stopRequested ? "stopped" : "completed", "socket closed"));
				stop = () => {
					stopRequested = true;
					ws.close();
				};
			}

			const task: BackgroundTask = {
				id,
				kind: "monitor",
				description: params.description,
				status,
				startedAt: Date.now(),
				output: () => stored,
				stop,
				finished,
			};
			// A one-shot monitor is awaited below and never addressable afterwards, so
			// it is not registered behind task_output/task_stop (like bash's blocking
			// path); `persistent` cannot be honoured either — the deadline applies.
			if (!oneShot) {
				registry.register(task);
				updateWidget();
			}

			const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS, MAX_MONITOR_TIMEOUT_MS);
			if (oneShot || !params.persistent) {
				const timer = setTimeout(() => {
					if (task.status === "running") stop();
				}, timeoutMs);
				timer.unref?.();
			}

			if (oneShot) {
				const unhook = whenAborted(signal, stop);
				try {
					await finished;
				} finally {
					unhook();
				}
				const output = persistIfLarge(stored.trim() || "(no events)", { dir: sessionResultsDir(ctx), id: `monitor-${id}` });
				const finalStatus = task.status;
				let how: string = finalStatus;
				if (finalStatus === "stopped") {
					if (signal?.aborted) how = "stopped (tool call aborted)";
					else if (params.persistent) how = `stopped at its default deadline of ${timeoutMs} ms (persistent is not available in a one-shot session)`;
					else how = `stopped at its ${timeoutMs} ms deadline`;
				}
				return {
					content: [
						{
							type: "text",
							text: `Monitor ${id} (${params.description}) ${how} after ${eventCount} event(s). ${oneShotNote("monitor")}\n\n${output}`,
						},
					],
					// No taskId: nothing is registered behind task_output/task_stop.
					details: { status: finalStatus, events: eventCount },
					isError: finalStatus === "failed",
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Monitor ${id} started (${params.description}). Events arrive as task notifications; stop with task_stop, inspect with task_output.`,
					},
				],
				details: { taskId: id },
			};
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		...ccToolRenderers("Task Output"),
		description:
			"Retrieve output from a running or finished background task (monitor, background subagent, or background bash) by task id. block=true (default) waits up to `timeout` ms for completion; block=false returns the current status immediately. You never need this just to learn that a task finished — completion arrives as a task notification naming the output file; call this for the output itself, when your next step needs the result now, or for a mid-run peek.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The task id to get output from" }),
			block: Type.Optional(Type.Boolean({ description: "Wait for completion (default true)" })),
			timeout: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_BLOCK_TIMEOUT_MS, description: "Max wait in ms (default 30000)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = registry.get(params.task_id);
			if (!task) {
				const known = registry.list().map((t) => t.id).join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `No background task "${params.task_id}". Known tasks: ${known}` }],
					details: {},
					isError: true,
				};
			}

			if (params.block !== false && task.status === "running") {
				const timeoutMs = Math.min(params.timeout ?? 30_000, MAX_BLOCK_TIMEOUT_MS);
				await Promise.race([
					task.finished,
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, timeoutMs);
						timer.unref?.();
						signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						}, { once: true });
					}),
				]);
			}

			updateWidget();
			const header = formatTaskLine(task);
			const body = tail(task.output(), OUTPUT_CAP) || "(no output yet)";
			// The model now holds a finished task's output: a completion notification
			// still waiting to go out for it is redundant (lib/notifications.ts).
			if (task.status !== "running") pi.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: task.id } satisfies TaskOutputDelivered);
			return {
				content: [{ type: "text", text: `${header}\n\n${body}` }],
				details: { taskId: task.id, status: task.status, logPath: task.logPath },
			};
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop Task",
		...ccToolRenderers("Stop Task"),
		description: "Stop a running background task (monitor, background subagent, or background bash) by task id.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The id of the background task to stop" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = registry.get(params.task_id);
			if (!task) {
				const known = registry.list().map((t) => t.id).join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `No background task "${params.task_id}". Known tasks: ${known}` }],
					details: {},
					isError: true,
				};
			}
			if (task.status !== "running" && !task.resident?.()) {
				return { content: [{ type: "text", text: `Task ${task.id} is already ${task.status}.` }], details: { taskId: task.id } };
			}
			const wasResident = task.status !== "running";
			task.stop();
			updateWidget();
			return {
				content: [
					{
						type: "text",
						text: wasResident
							? `Terminated the resident agent behind ${task.id} (${task.description}); it can no longer be messaged live (send_message will resume it from its session file).`
							: `Stop requested for ${task.id} (${task.description}).`,
					},
				],
				details: { taskId: task.id },
			};
		},
	});

	pi.registerTool({
		name: "schedule_wakeup",
		label: "Schedule Wakeup",
		...ccToolRenderers<{ delaySeconds?: number; stop?: boolean }>("Schedule Wakeup", {
			title: (a) => (a?.stop ? "stop" : a?.delaySeconds !== undefined ? `${a.delaySeconds}s` : undefined),
		}),
		description: SCHEDULE_WAKEUP_DESCRIPTION,
		parameters: Type.Object({
			delaySeconds: Type.Optional(Type.Number({ description: SCHEDULE_WAKEUP_PARAMS.delaySeconds })),
			reason: Type.Optional(Type.String({ description: SCHEDULE_WAKEUP_PARAMS.reason })),
			prompt: Type.Optional(Type.String({ description: SCHEDULE_WAKEUP_PARAMS.prompt })),
			stop: Type.Optional(Type.Boolean({ description: SCHEDULE_WAKEUP_PARAMS.stop })),
			noop: Type.Optional(Type.Boolean({ description: SCHEDULE_WAKEUP_PARAMS.noop })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			if (params.stop === true) {
				const cancelled = dynamicLoop.stop();
				runCron();
				return { content: [{ type: "text", text: formatStopped(cancelled) }], details: { stopped: true, cancelledWakeups: cancelled } };
			}
			if (params.delaySeconds === undefined || params.reason === undefined) return fail(WAKEUP_ERRORS.delayAndReason);
			if (params.prompt === undefined) return fail(WAKEUP_ERRORS.prompt);
			if (params.noop === undefined) return fail(WAKEUP_ERRORS.noop);
			const now = Date.now();
			const scheduled = dynamicLoop.schedule(params.delaySeconds, params.prompt, now);
			runCron();
			if (!scheduled) return { content: [{ type: "text", text: AGED_OUT_RESULT }], details: { scheduledFor: 0 } };
			const text = formatScheduled(scheduled, now);
			return {
				content: [{ type: "text", text: sessionOutlivesTurn(ctx.mode) ? text : `${text} ${formatCannotFire()}` }],
				details: { ...scheduled, reason: params.reason, noop: params.noop },
			};
		},
	});

	pi.registerTool({
		name: "cron_create",
		label: "Cron Create",
		...ccToolRenderers<{ cron?: string }>("Cron Create", { title: (a) => a?.cron }),
		description: CRON_CREATE_DESCRIPTION,
		parameters: CRON_CREATE_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const created = cron.create({ cron: params.cron, prompt: params.prompt, recurring: params.recurring }, Date.now());
			if (!created.ok) return { content: [{ type: "text", text: created.error }], details: {}, isError: true };
			runCron();
			const text = formatCreateResult(created.job);
			return {
				content: [{ type: "text", text: sessionOutlivesTurn(ctx.mode) ? text : `${text} ${formatCannotFire()}` }],
				details: { jobId: created.job.id, cron: created.job.cron, recurring: created.job.recurring, nextFireAt: created.job.nextFireAt },
			};
		},
	});

	pi.registerTool({
		name: "cron_list",
		label: "Cron List",
		...ccToolRenderers("Cron List"),
		description: CRON_LIST_DESCRIPTION,
		parameters: CRON_LIST_PARAMETERS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const jobs = cron.list();
			return { content: [{ type: "text", text: formatJobList(jobs) }], details: { count: jobs.length } };
		},
	});

	pi.registerTool({
		name: "cron_delete",
		label: "Cron Delete",
		...ccToolRenderers<{ id?: string }>("Cron Delete", { title: (a) => a?.id }),
		description: CRON_DELETE_DESCRIPTION,
		parameters: CRON_DELETE_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (!cron.delete(params.id)) return { content: [{ type: "text", text: formatUnknownJob(params.id) }], details: {}, isError: true };
			runCron();
			return { content: [{ type: "text", text: formatDeleteResult(params.id) }], details: { jobId: params.id } };
		},
	});

	for (const [name, keywords] of Object.entries({
		monitor: ["monitor", "watch", "background", "tail", "events", "stream", "websocket"],
		task_output: ["task", "background", "output", "status", "wait"],
		task_stop: ["task", "background", "stop", "kill", "cancel"],
		schedule_wakeup: ["wakeup", "loop", "schedule", "timer", "recurring", "later"],
		cron_create: ["cron", "schedule", "recurring", "remind", "timer", "every", "later"],
		cron_list: ["cron", "schedule", "list", "jobs", "scheduled"],
		cron_delete: ["cron", "schedule", "cancel", "delete", "stop"],
	})) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords });
	}

	registerLocalCommand(pi, "background", {
		description: "List background tasks (monitors, background subagents)",
		handler: async (args, ctx) => {
			const tasks = registry.list();
			ctx.ui.notify(tasks.length ? tasks.map(formatTaskLine).join("\n") : "No background tasks.", "info");
		},
	});

	// `/loop` is a bundled skill whose body depends on its arguments; build it
	// for the skill extension (lib/skill-body.ts). Only our own SKILL.md: a
	// project skill named "loop" keeps its file's body.
	const loopSkillPath = join(BUNDLED_SKILLS_DIR, "loop", "SKILL.md");
	pi.events.on(SKILL_BODY_CHANNEL, (data) => {
		const query = data as SkillBodyQuery;
		if (query.skill !== "loop" || resolve(query.path) !== loopSkillPath) return;
		query.body = loopSkillPrompt(query.args, readLoopFile(query.cwd));
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		sessionCwd = ctx.cwd;
		if (pendingShutdownNotice) {
			const notice = pendingShutdownNotice;
			pendingShutdownNotice = undefined;
			if (ctx.hasUI) ctx.ui.notify(notice, "info");
		}
	});
	pi.on("agent_start", () => {
		agentBusy = true;
	});
	pi.on("agent_settled", () => {
		agentBusy = false;
		// Claude Code's keepalive: a wakeup's turn that scheduled no next one gets one fallback.
		dynamicLoop.settle(Date.now());
		runCron();
	});
	// Folded no-op ticks leave the model's context (noop-fold.ts); the note stands in for them.
	pi.on("context", (event) => {
		const messages = applyNoopFolds(event.messages as Array<AgentMessage & { role: string }>, (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp }) as AgentMessage & { role: string });
		return messages ? { messages } : undefined;
	});
	// The first fire after a compaction resends the full loop instructions, as in Claude Code.
	pi.on("session_compact", () => {
		loopDelivery = freshDeliveryState();
	});

	pi.on("session_shutdown", (event) => {
		// Fires on /clear, /new, /resume and /reload too (findings §8). Everything
		// running dies with this instance — the replacement instance has no handle
		// on it — and the replacement is told (see pendingShutdownNotice); a quit
		// needs no note. A reload keeps the conversation, so its note says so.
		const running = registry.running();
		const jobs = cron.list();
		if ((running.length > 0 || jobs.length > 0) && event.reason !== "quit") {
			const when = event.reason === "reload" ? "on reload" : "with the previous session";
			const notices: string[] = [];
			if (running.length > 0) {
				const names = running.map((t) => `${t.id} (${t.description})`).join(", ");
				notices.push(`Stopped ${running.length} background task${running.length === 1 ? "" : "s"} ${when}: ${names}.`);
			}
			if (jobs.length > 0) {
				const names = jobs.map((j) => `${j.id} (${describeCadence(j.cron)})`).join(", ");
				notices.push(`Cancelled ${jobs.length} scheduled job${jobs.length === 1 ? "" : "s"} ${when}: ${names}.`);
			}
			pendingShutdownNotice = notices.join(" ");
		}
		registry.stopAll();
		cron.clear();
		dynamicLoop.clear();
		if (cronTimer) clearTimeout(cronTimer);
		cronTimer = undefined;
		lastCtx = undefined;
	});
}
