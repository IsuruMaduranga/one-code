/**
 * background extension — Claude Code's background-task surface:
 * monitor, task_output, task_stop, schedule_wakeup.
 *
 * Owns the BackgroundRegistry. Other extensions (subagents) register their
 * long-running work over TASK_REGISTER_CHANNEL at runtime, so task_output and
 * task_stop address every background task in the session regardless of which
 * extension started it. Events and completions are delivered as steered
 * system notifications (lib/notifications.ts), never as user input.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { whenAborted } from "../lib/abort.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { detachedSpawnOptions, KILL_GRACE_MS, stopProcessTree, waitForChildExit } from "../lib/process-tree.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { bashSpawn, spawnShellCommand } from "../lib/shell-spawn.ts";
import { ccToolRenderers, customMessageText, liveUiCtx, notificationComponent } from "../lib/tui-render.ts";
import {
	type BackgroundTask,
	BackgroundRegistry,
	formatTaskLine,
	generateTaskId,
	TASK_REGISTER_CHANNEL,
} from "./registry.ts";
import {
	buildDynamicLoopPrompt,
	buildLoopMessage,
	buildWakeupMessage,
	clampDelaySeconds,
	describeSchedule,
	MAX_DELAY_SECONDS,
	MIN_DELAY_SECONDS,
	parseLoopArgs,
} from "./wakeup.ts";
import { createTaskNotifier, oneShotNote, sessionOutlivesTurn, systemNotification } from "../lib/notifications.ts";
import {
	batchSize,
	emptyBatch,
	formatMonitorBatch,
	MONITOR_BATCH_BUSY_MS,
	MONITOR_BATCH_IDLE_MS,
	type MonitorBatch,
	pushEvent,
} from "./monitor-batch.ts";

const OUTPUT_CAP = 30_000;
const STORED_OUTPUT_CAP = 200_000;
const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
const MAX_MONITOR_TIMEOUT_MS = 3_600_000;
const MAX_BLOCK_TIMEOUT_MS = 600_000;
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

export default function backgroundExtension(pi: ExtensionAPI) {
	// After session_shutdown the captured ctx throws on every access and the
	// notifier is inert; a monitor whose command ends later (its shell was
	// killed, the orphaned command finished) must repaint nothing and say
	// nothing — before this guard, the widget repaint from the child's `close`
	// callback took the whole process down (LIFECYCLE-REVIEW-2026-09-06 H1).
	const alive = sessionAlive(pi);
	const registry = new BackgroundRegistry();
	let lastCtx: ExtensionContext | undefined;
	let wakeup: { timer: NodeJS.Timeout; prompt: string; reason: string } | undefined;
	// Fixed-interval /loop (harness-driven, auto-re-arming — distinct from the
	// model-driven `wakeup` used by dynamic /loop). One at a time, like wakeup.
	let loop: { timer: NodeJS.Timeout; intervalSeconds: number; task: string } | undefined;
	// True between agent_start and agent_settled, so a fixed-interval tick can skip
	// (not queue) while the previous tick's turn is still running — no backlog.
	// agent_settled, not agent_end: agent_end can precede an internal retry /
	// auto-compaction / queued continuation, and a tick landing in that gap would
	// inject a turn while the prior one is still about to resume.
	let agentBusy = false;
	// Set when a dynamic /loop force-activated schedule_wakeup, so /loop stop can
	// restore the lean tool surface it changed.
	let activatedWakeupTool = false;

	pi.events.on(TASK_REGISTER_CHANNEL, (task) => registry.register(task as BackgroundTask));

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

	// Harness-injected notifications carry anti-confabulation framing for the
	// model; the transcript shows a compact headline instead (ctrl+o expands).
	// One registration covers every emitter of the type (bash uses it too).
	for (const customType of ["task-notification", "wakeup", "loop"]) {
		pi.registerMessageRenderer(customType, (message, { expanded }, theme) =>
			notificationComponent(theme, customMessageText(message.content), expanded),
		);
	}

	const notify = createTaskNotifier(pi);

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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
				notify("task-notification", systemNotification(formatMonitorBatch(id, params.description, batch)), {
					taskId: id,
					events: batchSize(batch),
				});
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
				notify(
					"task-notification",
					systemNotification(`Monitor ${id} (${params.description}) ${finalStatus}${note ? ` — ${note}` : ""} after ${eventCount} event(s).`),
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
						text: `Monitor ${id} started (${params.description}). Events arrive as system notifications; stop with task_stop, inspect with task_output.`,
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
			"Retrieve output from a running or finished background task (monitor, background subagent, or background bash) by task id. block=true (default) waits up to `timeout` ms for completion; block=false returns the current status immediately. You never need this just to learn that a task finished — completion arrives as a system notification with the status and the last 2 KB of output; call this for the rest of the output, when your next step needs the result now, or for a mid-run peek.",
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
		description:
			"Schedule when to resume work on a self-paced recurring task — the dynamic mode of the /loop command. After `delaySeconds` (clamped to [60, 3600]) the given prompt is delivered as a system notification and a new turn starts. One wakeup is pending at a time — scheduling again replaces it; {stop: true} ends the loop and cancels any pending wakeup.\n\nPass the same task back via `prompt` each turn so the next firing repeats it. Set `noop: true` when nothing changed this tick (you checked and there's nothing to report); `noop: false` when something happened worth keeping. Pick `delaySeconds` from what you're actually waiting for: poll external state (a CI run, a deploy) at the rate it changes; for a quiet idle heartbeat prefer a long delay (1200s+). Do NOT schedule a short wakeup just to poll background work you started here — its completion already notifies you.",
		parameters: Type.Object({
			delaySeconds: Type.Optional(Type.Number({ description: "Seconds from now to wake up, clamped to [60, 3600]. Required unless stop is true" })),
			prompt: Type.Optional(Type.String({ description: "The task to continue when the wakeup fires. Required unless stop is true" })),
			reason: Type.Optional(Type.String({ description: "One short sentence explaining the chosen delay; shown to the user. Required unless stop is true" })),
			noop: Type.Optional(Type.Boolean({ description: "true when nothing changed this tick (quiet hold); false when something happened worth keeping" })),
			stop: Type.Optional(Type.Boolean({ description: "End the loop: cancel any pending wakeup and schedule nothing" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const clearPending = () => {
				if (wakeup) {
					clearTimeout(wakeup.timer);
					wakeup = undefined;
				}
			};
			if (params.stop) {
				clearPending();
				return { content: [{ type: "text", text: "Wakeup loop stopped; no further wakeups will fire." }], details: {} };
			}
			// Validate BEFORE touching the pending wakeup: clearing it up front meant
			// a malformed reschedule silently killed a running /loop with no signal.
			if (params.delaySeconds === undefined || !params.prompt || !params.reason) {
				return {
					content: [
						{
							type: "text",
							text: `delaySeconds, prompt, and reason are all required unless stop is true.${wakeup ? " Your previous wakeup is still pending — this call was rejected and left it untouched." : ""}`,
						},
					],
					details: {},
					isError: true,
				};
			}
			// Valid reschedule — now it is safe to replace any pending wakeup.
			clearPending();

			const request = { delaySeconds: params.delaySeconds, prompt: params.prompt, reason: params.reason, noop: params.noop };
			const delayMs = clampDelaySeconds(params.delaySeconds) * 1000;
			const timer = setTimeout(() => {
				wakeup = undefined;
				notify("wakeup", buildWakeupMessage(request), { reason: request.reason, noop: request.noop ?? false });
			}, delayMs);
			timer.unref?.();
			wakeup = { timer, prompt: params.prompt, reason: params.reason };
			return { content: [{ type: "text", text: describeSchedule(request) }], details: { delayMs, noop: params.noop ?? false } };
		},
	});

	for (const [name, keywords] of Object.entries({
		monitor: ["monitor", "watch", "background", "tail", "events", "stream", "websocket"],
		task_output: ["task", "background", "output", "status", "wait"],
		task_stop: ["task", "background", "stop", "kill", "cancel"],
		schedule_wakeup: ["wakeup", "loop", "schedule", "timer", "recurring", "later"],
	})) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords });
	}

	pi.registerCommand("background", {
		description: "List background tasks (monitors, background subagents)",
		handler: async (_args, ctx) => {
			const tasks = registry.list();
			ctx.ui.notify(tasks.length ? tasks.map(formatTaskLine).join("\n") : "No background tasks.", "info");
		},
	});

	const clearLoop = () => {
		if (loop) {
			clearInterval(loop.timer);
			loop = undefined;
		}
	};
	const clearWakeup = () => {
		if (wakeup) {
			clearTimeout(wakeup.timer);
			wakeup = undefined;
		}
	};

	pi.registerCommand("loop", {
		description: "Repeat a task on a loop: `/loop 5m <task>` (fixed interval) or `/loop <task>` (self-paced). `/loop stop` ends it.",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const raw = (args ?? "").trim();
			const keyword = raw.toLowerCase();

			if (keyword === "stop") {
				const had = Boolean(loop || wakeup);
				clearLoop();
				clearWakeup();
				if (activatedWakeupTool) {
					const active = pi.getActiveTools();
					if (active.includes("schedule_wakeup")) pi.setActiveTools(active.filter((t) => t !== "schedule_wakeup"));
					activatedWakeupTool = false;
				}
				ctx.ui.notify(had ? "Loop stopped; no further iterations will fire." : "No loop was running.", "info");
				return;
			}
			if (raw === "" || keyword === "status") {
				const parts: string[] = [];
				if (loop) parts.push(`fixed interval every ${loop.intervalSeconds}s — ${loop.task}`);
				if (wakeup) parts.push(`self-paced wakeup pending — ${wakeup.reason}`);
				ctx.ui.notify(
					parts.length
						? `Running:\n- ${parts.join("\n- ")}\nStop with /loop stop.`
						: "No loop running. Start with `/loop [interval] <task>`, e.g. `/loop 5m check the build`.",
					"info",
				);
				return;
			}

			const parsed = parseLoopArgs(raw);
			if (!parsed.task) {
				ctx.ui.notify("Give a task to loop, e.g. `/loop 10m check for new PRs` or `/loop watch the deploy`.", "info");
				return;
			}

			// One loop at a time — replace any existing interval loop or pending wakeup.
			clearLoop();
			clearWakeup();

			if (parsed.intervalSeconds !== undefined) {
				// Fixed interval, harness-driven: re-arm automatically and fire the first tick now.
				const seconds = clampDelaySeconds(parsed.intervalSeconds);
				const adjusted =
					seconds !== parsed.intervalSeconds
						? ` (adjusted from ${parsed.intervalSeconds}s; allowed range ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS}s)`
						: "";
				// Skip (don't queue) a tick while the previous tick's turn is still
				// running, so a slow task can't build a backlog of stale iterations.
				const tick = () => {
					if (agentBusy) return;
					notify("loop", buildLoopMessage(parsed.task), { intervalSeconds: seconds });
				};
				const timer = setInterval(tick, seconds * 1000);
				timer.unref?.();
				loop = { timer, intervalSeconds: seconds, task: parsed.task };
				ctx.ui.notify(`Looping every ${seconds}s${adjusted}: ${parsed.task}. Stop with /loop stop.`, "info");
				tick(); // fire the first iteration now
				return;
			}

			// Dynamic (self-paced): the model drives schedule_wakeup, so make sure it is
			// active — remembering we did, so /loop stop can restore the lean surface.
			const active = pi.getActiveTools();
			if (!active.includes("schedule_wakeup")) {
				pi.setActiveTools([...active, "schedule_wakeup"]);
				activatedWakeupTool = true;
			}
			ctx.ui.notify(`Self-paced loop started: ${parsed.task}. Stop with /loop stop.`, "info");
			notify("loop", buildDynamicLoopPrompt(parsed.task), {});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
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
	});

	pi.on("session_shutdown", (event) => {
		// Fires on /clear, /new, /resume and /reload too (findings §8). Everything
		// running dies with this instance — the replacement instance has no handle
		// on it — and the replacement is told (see pendingShutdownNotice); a quit
		// needs no note. A reload keeps the conversation, so its note says so.
		const running = registry.running();
		if (running.length > 0 && event.reason !== "quit") {
			const names = running.map((t) => `${t.id} (${t.description})`).join(", ");
			const when = event.reason === "reload" ? "on reload" : "with the previous session";
			pendingShutdownNotice = `Stopped ${running.length} background task${running.length === 1 ? "" : "s"} ${when}: ${names}.`;
		}
		registry.stopAll();
		clearWakeup();
		clearLoop();
		lastCtx = undefined;
	});
}
