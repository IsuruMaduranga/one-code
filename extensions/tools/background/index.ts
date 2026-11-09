/**
 * background extension — Claude Code's background-task surface:
 * monitor, task_output, task_stop, schedule_wakeup, cron_create, cron_list,
 * cron_delete, and /loop.
 *
 * Owns the BackgroundRegistry. Other extensions (subagents) register their
 * long-running work over TASK_REGISTER_CHANNEL at runtime, so task_output and
 * task_stop address every background task in the session regardless of which
 * extension started it. Events and completions are delivered as steered
 * task notifications (lib/notify/notifications.ts), never as user input; a fired
 * wakeup or cron job re-invokes the session with its prompt verbatim.
 *
 * Every scheduled prompt lives in one CronStore (cron.ts): cron_create jobs
 * and schedule_wakeup's one-shot wakeups (wakeup.ts). One timer is armed to
 * the store's next fire; jobs fire only while the agent is idle, so a job
 * that came due during a turn fires once at agent_settled. `/loop` is
 * Claude Code's skill (skills/loop, its body built by loop-skill.ts): the
 * model schedules the loop itself.
 */

import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { whenAborted } from "../../lib/core/abort.ts";
import { DEFER_CHANNEL } from "../../lib/request/deferred.ts";
import { persistedFilePreview, persistIfLarge, sessionResultsDir } from "../../lib/request/persisted-output.ts";
import { detachedSpawnOptions, KILL_GRACE_MS, rememberProcessGroup, stopProcessTree, waitForChildExit } from "../../lib/shell-run/process-tree.ts";
import { sessionAlive } from "../../lib/notify/session-lifecycle.ts";
import { bashSpawn, spawnShellCommand } from "../../lib/shell-run/shell-spawn.ts";
import { ccToolRenderers, customMessageText, expandHintFor, formatFireTime, liveUiCtx, notificationComponent, notificationUserMarkdown, scheduledTaskComponent } from "../../lib/ui/tui-render.ts";
import {
	type BackgroundTask,
	BackgroundRegistry,
	generateTaskId,
	shownTask,
	TASK_REGISTER_CHANNEL,
} from "../../lib/agents/task-registry.ts";
import { SWITCH_CANCEL, SWITCH_STOP, switchWarning, workWidgetLine } from "./switch-guard.ts";
import { DynamicLoop, scheduledText } from "./wakeup.ts";
import type { MonitorEnd, MonitorStartFailure, TaskToolsText, WakeupMissingField } from "./text.ts";
import {
	deliveryFromState,
	isAutonomousSentinel,
	isLoopFileSentinel,
	LOOP_DELIVERY_DETAILS_KEY,
	LOOP_DELIVERY_STATE,
	type LoopDeliveryState,
	readLoopFile,
	resolveLoopFire,
} from "./loop-fire.ts";
import { loopPersistent, loopSkillForm } from "./loop-skill.ts";
import {
	CronStore,
	type CronFire,
	type CronJob,
	cronToolParameters,
	describeCadence,
	JOB_FIRED_ENTRY,
	RECURRING_MAX_AGE_DAYS,
	scheduledJobsOnBranch,
	shownJob,
	WAKEUP_ARMED_ENTRY,
} from "../../lib/agents/cron.ts";
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
} from "../../lib/notify/notifications.ts";
import {
	batchSize,
	emptyBatch,
	formatMonitorEvents,
	MONITOR_BATCH_BUSY_MS,
	MONITOR_BATCH_MAX_CHARS,
	MONITOR_BATCH_IDLE_MS,
	type MonitorBatch,
	MonitorLineSplitter,
	withoutJobReport,
	pushEvent,
} from "./monitor-batch.ts";
import { registerLocalCommand } from "../../lib/ui/local-command.ts";
import { applyNoopFolds, decideFold, type FoldDetails, type FoldEntry, foldSuffix } from "./noop-fold.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AGENT_CRON_CHANNEL, AGENT_CRON_FIRE_CHANNEL, type AgentCronFire, type AgentCronRequest, type FireConversation } from "../../lib/agents/agent-cron.ts";
import { requireText } from "../../lib/profile/profile.ts";
import { SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../../lib/plugins/skill-body.ts";
import { BUNDLED_SKILLS_DIR } from "../../lib/plugins/skill-scan.ts";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SESSION_WORK_CHANNEL, sessionBackgroundTask, sessionCron, type SessionWorkQuery } from "../../lib/notify/session-work.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../../lib/agents/worktree-channel.ts";
import { queueNotice } from "../../lib/notify/notices.ts";
import { makeRecord, RECORD } from "../../lib/request/ledger/records.ts";
import { recordState, stateSinceCompaction } from "../../lib/request/ledger/state.ts";
import { processState } from "../../lib/profile/process-state.ts";
import { extensionVersion } from "../../lib/app/package-version.ts";
import { STORED_OUTPUT_CAP, tailCap } from "../../lib/shell-run/bash-background.ts";

/** Claude Code's `task_output` limit (`TASK_MAX_OUTPUT_DEFAULT`). */
const TASK_OUTPUT_MAX_CHARS = 32_000;
const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
const MAX_MONITOR_TIMEOUT_MS = 3_600_000;
const MAX_BLOCK_TIMEOUT_MS = 600_000;
/** setTimeout's longest delay; a later fire re-arms when this one wakes. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `/clear`, `/new`, `/resume` and `/reload` stop every background task with
 * the session they belong to (the notifier that would report them is inert by
 * then, and the new instance has no handle on them). Say so, once, in the NEW
 * session: the old session's UI is torn down right after `session_shutdown`,
 * so a notice printed there is lost (LIFECYCLE-REVIEW-2026-09-06 L3). The
 * notice is process state (lib/profile/process-state.ts): module scope would lose it
 * wherever pi evaluates this module again, at `/reload` and at a `/resume`
 * into another directory (lifecycle grid R3-L13).
 */
const shutdownNotice = () => processState<{ text?: string }>("background:shutdown-notice", () => ({}));

/**
 * `<sessionDir>/monitor/<taskId>/output.log`, beside background shells'
 * `bash/<taskId>/`. A session-less run spools under the session's private
 * results dir (`sessionResultsDir`), so its output is never kept only as the
 * in-memory tail. Undefined when the folder cannot be made.
 */
function monitorLogPath(ctx: ExtensionContext, taskId: string): string | undefined {
	try {
		const dir = join(sessionResultsDir(ctx), "monitor", taskId);
		mkdirSync(dir, { recursive: true });
		return join(dir, "output.log");
	} catch {
		return undefined;
	}
}

/**
 * `task_output`'s body. Past `TASK_OUTPUT_MAX_CHARS` a task with a spool file
 * gets Claude Code's clip, `[Truncated. Full output: <path>]` and the tail
 * that fits, since the file holds the full text; a task without one (a
 * subagent's report) is persisted whole to the session's tool-results
 * folder, never cut (decisions/tools.md).
 */
function taskOutputBody(task: BackgroundTask, ctx: ExtensionContext, text: TaskToolsText): string {
	const output = task.output();
	if (output.length <= TASK_OUTPUT_MAX_CHARS) return output;
	if (task.logPath) {
		const header = text.clippedHeader({ path: task.logPath });
		return `${header}${output.slice(-(TASK_OUTPUT_MAX_CHARS - header.length))}`;
	}
	return persistIfLarge(output, { dir: sessionResultsDir(ctx), id: `task-output-${task.id}`, maxBytes: TASK_OUTPUT_MAX_CHARS });
}

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

function backgroundExtension(pi: ExtensionAPI) {
	const text = requireText("background");
	const cronParameters = cronToolParameters(text.cron);
	const created = (job: CronJob) => text.cron.created({ job: shownJob(job), maxAgeDays: RECURRING_MAX_AGE_DAYS });
	const jobList = (jobs: CronJob[]) => text.cron.list({ jobs: jobs.map(shownJob) });
	/** A scheduling result, with the never-fires note in a one-shot run. */
	const scheduling = (result: string, ctx: ExtensionContext) => (sessionOutlivesTurn(ctx.mode) ? result : `${result} ${text.cron.neverFires}`);
	const monitorParams = text.monitor.params({ defaultTimeoutMs: DEFAULT_MONITOR_TIMEOUT_MS, maxTimeoutMs: MAX_MONITOR_TIMEOUT_MS });
	const spoolLost = text.monitor.spoolLost({ keptChars: STORED_OUTPUT_CAP });
	const unknownTask = (id: string) => ({
		content: [{ type: "text" as const, text: text.tasks.unknownTask({ id, known: registry.list().map((t) => t.id) }) }],
		details: {},
		isError: true,
	});
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

	pi.events.on(TASK_REGISTER_CHANNEL, (data) => {
		const task = data as BackgroundTask;
		registry.register(task);
		// Shells and subagent runs count toward the widget's warning line too.
		updateWidget();
		task.finished?.then(updateWidget, updateWidget);
	});
	// A subagent's cron tools (lib/agents/agent-cron.ts): its jobs, its view, its deletes.
	pi.events.on(AGENT_CRON_CHANNEL, (data) => {
		const request = data as AgentCronRequest;
		if (request.op === "create") {
			const result = cron.create({ cron: request.cron, prompt: request.prompt, recurring: request.recurring, agentId: request.agentId, cwd: request.cwd }, Date.now());
			request.result = result.ok
				? { text: created(result.job), details: { jobId: result.job.id } }
				: { text: text.cron.createFailed(result.failure), isError: true };
			if (result.ok) runCron();
		} else if (request.op === "list") {
			const jobs = cron.list().filter((job) => job.agentId === request.agentId);
			request.result = { text: jobList(jobs), details: { jobCount: jobs.length } };
		} else {
			const job = cron.get(request.id);
			if (!job) request.result = { text: text.cron.unknownJob({ id: request.id }), isError: true };
			else if (job.agentId !== request.agentId) request.result = { text: text.cron.notOwner({ id: request.id }), isError: true };
			else {
				cron.delete(request.id);
				runCron();
				request.result = { text: text.cron.deleted({ id: request.id }) };
			}
		}
	});
	// The Stop hook's session_crons / background_tasks (lib/notify/session-work.ts).
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
		// Every running task and scheduled job, panel-owned ones included: the
		// line is the warning of what /clear, /reload or quitting stops (switch-guard.ts).
		const line = workWidgetLine(registry.running().length, cron.list().length);
		live.ui.setWidget("cc-background", line ? [line] : undefined);
	};

	// The wire frames are model-facing; the transcript shows a compact headline
	// instead (ctrl+o expands). One registration covers every emitter of
	// `task-notification` (bash uses it too). A fired wakeup or loop tick is the
	// prompt verbatim, shown behind Claude Code's "Running scheduled task" line.
	pi.registerMessageRenderer("task-notification", (message, options, theme) =>
		notificationComponent(theme, customMessageText(message.content), options.expanded, { hint: expandHintFor(options) }),
	);
	// A notification that opens the session's first turn is a user message
	// (lib/notify/notifications.ts, "First turn of a session"); pi draws those as
	// markdown, so the same headline replaces the frames here. Every notifier's
	// messages pass through this one transformer.
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" ? (notificationUserMarkdown(markdown) ?? markdown) : markdown,
	);
	for (const customType of ["wakeup", "cron"]) {
		// Claude Code: "Claude resuming /loop wakeup (…)" for a wakeup; the model here may not be Claude.
		const label = customType === "wakeup" ? "Resuming /loop wakeup" : undefined;
		pi.registerMessageRenderer(customType, (message, options, theme) => {
			const fold = message.details as FoldDetails | undefined;
			const suffix = fold?.noOpStreak ? foldSuffix(fold.noOpStreak, formatFireTime(fold.streakStartedAt ?? Date.now())) : "";
			return scheduledTaskComponent(theme, customMessageText(message.content), (message as { timestamp?: number }).timestamp ?? Date.now(), options.expanded, { label, suffix, hint: expandHintFor(options) });
		});
	}

	// A monitor's end the model already read through task_output is withdrawn
	// like a shell's (lib/notify/notifications.ts).
	const notify = createTaskNotifier(pi, {
		withdrawOnDelivery: true,
		// A fire's message reached the conversation: what it told the model is on the branch from here.
		onDelivered: (customType, details) => {
			if (customType !== "cron" && customType !== "wakeup") return;
			const stored = details[LOOP_DELIVERY_DETAILS_KEY];
			if (stored !== undefined) recordDelivery(pi, deliveryFromState(stored));
		},
	});

	/**
	 * A no-prompt /loop sentinel's text (loop-fire.ts), against what the
	 * conversation it lands in was already sent. That record is branch state
	 * of that conversation: the main session's, or a subagent's own session,
	 * since each has its own history and compacts on its own. Read since the
	 * last compaction, so the first fire after one resends the instructions,
	 * as Claude Code does. `delivery` is the record this text makes true, set
	 * only when it changes (lifecycle grid R3-L12); the caller writes it when
	 * the text reaches the conversation.
	 */
	const expandSentinel = (prompt: string, cwd: string, conversation: FireConversation | undefined): { text: string; delivery?: LoopDeliveryState } => {
		let branch: readonly unknown[] = [];
		try {
			branch = conversation?.getBranch() ?? [];
		} catch {
			// A torn-down session reads as one that was sent nothing.
		}
		const before = deliveryFromState(stateSinceCompaction(branch, LOOP_DELIVERY_STATE));
		const state = { ...before };
		const fired = resolveLoopFire(state, prompt, cwd, text.loop, loopPersistent());
		const changed = state.autonomousPreambleDelivered !== before.autonomousPreambleDelivered || state.lastLoopFileDelivered !== before.lastLoopFileDelivered;
		return changed ? { text: fired, delivery: state } : { text: fired };
	};
	/** Record what a delivered fire told its conversation; a torn-down one has nothing to record into. */
	const recordDelivery = (conversation: Pick<FireConversation, "appendEntry">, delivery: LoopDeliveryState) => {
		try {
			recordState(conversation, LOOP_DELIVERY_STATE, delivery);
		} catch {
			// Same: nothing to record into.
		}
	};
	/** The main session as a fire's conversation, while it is live. */
	const mainConversation = (): FireConversation | undefined => {
		const ctx = lastCtx;
		return ctx ? { getBranch: () => ctx.sessionManager.getBranch(), appendEntry: (customType, data) => pi.appendEntry(customType, data) } : undefined;
	};

	/**
	 * The text a fired prompt delivers, as Claude Code's queue would run it: a
	 * no-prompt /loop sentinel expands (loop-fire.ts), and a slash command that
	 * names a skill runs that skill (lib/plugins/skill-body.ts); anything else is the
	 * prompt verbatim. Both resolve in the job owner's directory: a subagent's
	 * own, or the main session's worktree while it is in one.
	 */
	const fireText = (job: CronJob, conversation: FireConversation | undefined): { text: string; delivery?: LoopDeliveryState } => {
		const { prompt } = job;
		const cwd = job.cwd ?? worktreeCwd ?? sessionCwd;
		if (isAutonomousSentinel(prompt) || isLoopFileSentinel(prompt)) return expandSentinel(prompt, cwd, conversation);
		if (!prompt.startsWith("/")) return { text: prompt };
		const query: SlashExpandQuery = { text: prompt, cwd };
		pi.events.emit(SLASH_EXPAND_CHANNEL, query);
		return { text: query.expanded ?? prompt };
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
			// The agent's resident sends the text as soon as it asks for it, so the record goes with the text.
			const text = (conversation: FireConversation | undefined) => {
				const fired = fireText(job, conversation);
				if (fired.delivery && conversation) recordDelivery(conversation, fired.delivery);
				return fired.text;
			};
			const delivery: AgentCronFire = { agentId: job.agentId, jobId: job.id, text };
			pi.events.emit(AGENT_CRON_FIRE_CHANNEL, delivery);
			// The agent has ended: its job goes with it.
			if (!delivery.delivered) cron.delete(job.id);
			return;
		}
		const fold = job.source === "wakeup" ? foldDetails() : {};
		// A fold removes the tick's messages from the model's context: above the
		// append point, so the next request opens an epoch (extensions/request/ledger)
		// and renders the folded context whole, once.
		if (fold.noOpStreak !== undefined) pi.appendEntry(RECORD.epoch, makeRecord("epoch", extensionVersion(), { cause: "fold" }));
		if (job.source === "wakeup") dynamicLoop.inFlight = job.prompt;
		// Recorded whatever way the notification goes out, so a /reload knows the fire happened.
		pi.appendEntry(JOB_FIRED_ENTRY, { jobId: job.id, final, source: job.source });
		// The notifier may hold the message (a coalescing window, an interrupt) and
		// a /reload drops what it holds, so the loop's record rides the message and
		// is written when it is delivered (the notifier's onDelivered above).
		const { text, delivery } = fireText(job, mainConversation());
		const details = { jobId: job.id, cron: job.cron, source: job.source, final, ...fold, ...(delivery ? { [LOOP_DELIVERY_DETAILS_KEY]: delivery } : {}) };
		notify(job.source === "wakeup" ? "wakeup" : "cron", text, details);
	};
	/** Fire every due job (only while idle), then arm the one timer to the next fire. */
	const runCron = () => {
		if (cronTimer) clearTimeout(cronTimer);
		cronTimer = undefined;
		// A busy agent re-runs this at agent_settled; a dead session never does.
		if (!alive() || agentBusy) {
			updateWidget();
			return;
		}
		for (const fire of cron.takeDue(Date.now())) fireCron(fire);
		updateWidget();
		const next = cron.nextFireAt();
		if (next === undefined) return;
		cronTimer = setTimeout(runCron, Math.min(Math.max(0, next - Date.now()), MAX_TIMER_MS));
		cronTimer.unref?.();
	};

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		...ccToolRenderers("Monitor"),
		description: text.monitor.description,
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: monitorParams.command })),
			description: Type.String({ description: monitorParams.description }),
			persistent: Type.Optional(Type.Boolean({ description: monitorParams.persistent })),
			timeout_ms: Type.Optional(Type.Number({ minimum: 1000, description: monitorParams.timeoutMs })),
			ws: Type.Optional(
				Type.Object(
					{
						url: Type.String(),
						protocols: Type.Optional(Type.Array(Type.String())),
					},
					{ description: monitorParams.ws },
				),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const startFailed = (failure: MonitorStartFailure) => ({ content: [{ type: "text" as const, text: text.monitor.startFailed(failure) }], details: {}, isError: true });
			if (Boolean(params.command) === Boolean(params.ws)) return startFailed({ kind: "commandOrSocket" });

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
			// The whole stream, spooled like a background shell's, so the batches'
			// "task_output has the full stream" and task_output's clip header point
			// at something true, and a one-shot result past the in-memory cap can
			// still persist every line. Opened on the first output.
			let log: WriteStream | undefined;
			let spoolFailed = false;
			let overflowed = false;
			const record = (chunk: string) => {
				if (stored.length + chunk.length > STORED_OUTPUT_CAP) overflowed = true;
				stored = tailCap(`${stored}${chunk}`, STORED_OUTPUT_CAP, text.monitor.earlierTruncated);
				if (!chunk || spoolFailed) return;
				if (!log) {
					const path = monitorLogPath(ctx, id);
					if (!path) return;
					log = createWriteStream(path, { flags: "a" });
					log.on("error", () => {
						// Best-effort, as bash's spool: the in-memory tail stays
						// authoritative, and nothing names a missing or partial file as
						// the full output any more.
						spoolFailed = true;
						task.logPath = undefined;
					});
					task.logPath = path;
				}
				log.write(chunk);
			};
			let eventCount = 0;
			let pending: MonitorBatch = emptyBatch();
			let flushTimer: NodeJS.Timeout | undefined;
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});

			const flush = (force = false) => {
				flushTimer = undefined;
				if (batchSize(pending) === 0) return;
				if (!force && notify.holding()) {
					// Held after an interrupt: one bounded batch accumulates (its
					// overflow counted) instead of one held message per flush, and
					// goes out once the next turn starts.
					flushTimer = setTimeout(() => flush(), MONITOR_BATCH_IDLE_MS);
					return;
				}
				const batch = pending;
				pending = emptyBatch();
				// CC's mid-run monitor batch: no status, the lines in `<event>`.
				notify(
					"task-notification",
					taskNotification({ kind: "monitor", taskId: id, summary: monitorEventSummary(params.description), result: formatMonitorEvents(id, batch, text.monitor.moreLines) }),
					{ taskId: id, events: batchSize(batch) },
				);
			};

			// Set by stop(): what the command prints on stdout while it is torn down (a
			// shell running the rest of `sleep 30; echo done` before the SIGKILL grace
			// ends) is not an event, so the count says what happened before the stop.
			// Stderr is kept, since an error written just before the stop can still be
			// in the pipe; only bash's report of the job the stop killed is dropped.
			let stopRequested = false;
			const onEvent = (line: string) => {
				if (stopRequested) return;
				eventCount++;
				record(`${line}\n`);
				if (oneShot) return; // collected into the tool result instead
				pushEvent(pending, line);
				// Bounded batches, and a wider window mid-turn so a chatty stream
				// coalesces instead of steering one notification per second
				// (monitor-batch.ts).
				flushTimer ??= setTimeout(() => flush(), agentBusy ? MONITOR_BATCH_BUSY_MS : MONITOR_BATCH_IDLE_MS);
			};

			const end = (finalStatus: BackgroundTask["status"], note?: string) => {
				if (status !== "running") return;
				status = finalStatus;
				if (flushTimer) clearTimeout(flushTimer);
				const complete = () => {
					if (task.status !== "running") return;
					// Terminal status and its notification promise readable final output.
					task.status = finalStatus;
					task.finishedAt = Date.now();
					finish();
					// After shutdown or inside a one-shot run, report through `finished` alone.
					if (!alive() || oneShot) return;
					flush(true);
					updateWidget();
					// CC's monitor end: the recent tail rides <event> under the ended summary.
					const ccStatus = taskStatusOf(finalStatus);
					const recent = tailCap(stored, MONITOR_BATCH_MAX_CHARS, text.monitor.earlierTruncated).trim();
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
				if (log && !log.closed) {
					// `close` follows a clean end and an error alike. A stuck stream
					// must not hold a blocking tool forever or advertise a partial file.
					const fallback = setTimeout(() => {
						spoolFailed = true;
						task.logPath = undefined;
						log?.destroy();
						complete();
					}, 1_000);
					log.once("close", () => {
						clearTimeout(fallback);
						complete();
					});
					log.end();
				} else {
					complete();
				}
			};

			let stop: () => void;
			if (params.command) {
				// Own process group: stop() must end the COMMAND, not just the `$SHELL -c`
				// leader — with zsh a `cmd; echo` or a pipeline otherwise lives on as an
				// orphan holding the stdout pipe, so the task never finishes and, in a
				// one-shot run, the process cannot exit (LIFECYCLE-REVIEW M2, measured).
				// The session's bash (Git Bash on Windows) — lib/shell-run/shell-spawn.ts.
				const bash = bashSpawn();
				if (!bash.spawn) return startFailed({ kind: "noShell", osMessage: bash.error });
				const child = spawnShellCommand(bash.spawn, params.command, {
					cwd: ctx.cwd,
					...detachedSpawnOptions(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				rememberProcessGroup(child);
				const lines = new MonitorLineSplitter();
				// Streaming decoders: a UTF-8 character split across reads stays whole.
				const stdoutText = new StringDecoder("utf8");
				const stderrText = new StringDecoder("utf8");
				child.stdout?.on("data", (chunk: Buffer) => {
					for (const line of lines.push(stdoutText.write(chunk))) onEvent(line);
				});
				const stderrRecord = (text: string) => record(stopRequested ? withoutJobReport(text) : text);
				child.stderr?.on("data", (chunk: Buffer) => {
					stderrRecord(stderrText.write(chunk));
				});
				// Exit plus a short stdio grace, not `close` (lib/shell-run/process-tree.ts).
				// The last line may have no newline; it is an event all the same.
				const drain = () => {
					for (const line of [...lines.push(stdoutText.end()), ...lines.end()]) onEvent(line);
					stderrRecord(stderrText.end());
				};
				waitForChildExit(child).then(
					({ code }) => {
						drain();
						end(stopRequested ? "stopped" : code === 0 ? "completed" : "failed", code !== null && code !== 0 ? `exit code ${code}` : undefined);
					},
					(error: Error) => {
						drain();
						end("failed", error.message);
					},
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
					return startFailed({ kind: "socketFailed", url: params.ws!.url, osMessage: (error as Error).message });
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
				output: () => (overflowed && !task.logPath ? `${spoolLost}${stored}` : stored || (task.status === "running" ? "" : text.monitor.noOutput)),
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
				// Past the in-memory cap the spool holds every line: point at it rather
				// than persist the tail. Without one, say what was lost.
				const spooled = overflowed && task.logPath ? persistedFilePreview(task.logPath) : undefined;
				const kept = overflowed && !spooled ? `${spoolLost}${stored.trim()}` : stored.trim() || text.monitor.noEvents;
				const output = spooled ?? persistIfLarge(kept, { dir: sessionResultsDir(ctx), id: `monitor-${id}` });
				const finalStatus = task.status;
				const end: MonitorEnd =
					finalStatus !== "stopped"
						? { kind: finalStatus === "failed" ? "failed" : "completed" }
						: signal?.aborted
							? { kind: "aborted" }
							: { kind: "deadline", ms: timeoutMs, persistentAsked: params.persistent === true };
				return {
					content: [
						{
							type: "text",
							text: text.monitor.ranToEnd({ id, description: params.description, end, events: eventCount, note: oneShotNote("monitor"), output }),
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
						text: text.monitor.started({ id, description: params.description }),
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
		description: text.tasks.outputDescription,
		parameters: Type.Object({
			task_id: Type.String({ description: text.tasks.outputParams.taskId }),
			block: Type.Optional(Type.Boolean({ description: text.tasks.outputParams.block })),
			timeout: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_BLOCK_TIMEOUT_MS, description: text.tasks.outputParams.timeout })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = registry.get(params.task_id);
			if (!task) return unknownTask(params.task_id);

			if (params.block !== false && task.status === "running") {
				const timeoutMs = Math.min(params.timeout ?? 30_000, MAX_BLOCK_TIMEOUT_MS);
				let timer: ReturnType<typeof setTimeout> | undefined;
				let unhook = () => {};
				try {
					await Promise.race([
						task.finished,
						new Promise<void>((resolve) => {
							// The tool awaits this deadline: keep it referenced in one-shot runs.
							timer = setTimeout(resolve, timeoutMs);
							unhook = whenAborted(signal, resolve);
						}),
					]);
				} finally {
					clearTimeout(timer);
					unhook();
				}
			}

			updateWidget();
			const header = text.tasks.taskLine(shownTask(task));
			const body = taskOutputBody(task, ctx, text.tasks) || text.tasks.noOutputYet;
			// The model now holds a finished task's output: a completion notification
			// still waiting to go out for it is redundant (lib/notify/notifications.ts).
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
		description: text.tasks.stopDescription,
		parameters: Type.Object({
			task_id: Type.String({ description: text.tasks.stopParams.taskId }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = registry.get(params.task_id);
			if (!task) return unknownTask(params.task_id);
			if (task.status !== "running" && !task.resident?.()) {
				return { content: [{ type: "text", text: text.tasks.alreadyEnded({ id: task.id, status: task.status }) }], details: { taskId: task.id } };
			}
			const wasResident = task.status !== "running";
			task.stop();
			updateWidget();
			return {
				content: [
					{
						type: "text",
						text: wasResident
							? text.tasks.residentEnded({ id: task.id, description: task.description })
							: text.tasks.stopRequested({ id: task.id, description: task.description }),
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
		description: text.wakeup.description,
		parameters: Type.Object({
			delaySeconds: Type.Optional(Type.Number({ description: text.wakeup.params.delaySeconds })),
			reason: Type.Optional(Type.String({ description: text.wakeup.params.reason })),
			prompt: Type.Optional(Type.String({ description: text.wakeup.params.prompt })),
			stop: Type.Optional(Type.Boolean({ description: text.wakeup.params.stop })),
			noop: Type.Optional(Type.Boolean({ description: text.wakeup.params.noop })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const fail = (field: WakeupMissingField) => ({ content: [{ type: "text" as const, text: text.wakeup.missing(field) }], details: {}, isError: true });
			if (params.stop === true) {
				const cancelled = dynamicLoop.stop();
				runCron();
				return { content: [{ type: "text", text: text.wakeup.stopped({ cancelled }) }], details: { stopped: true, cancelledWakeups: cancelled } };
			}
			if (params.delaySeconds === undefined || params.reason === undefined) return fail("delayAndReason");
			if (params.prompt === undefined) return fail("prompt");
			if (params.noop === undefined) return fail("noop");
			const now = Date.now();
			const scheduled = dynamicLoop.schedule(params.delaySeconds, params.prompt, now);
			runCron();
			if (!scheduled) return { content: [{ type: "text", text: text.wakeup.agedOut }], details: { scheduledFor: 0 } };
			return {
				content: [{ type: "text", text: scheduling(text.wakeup.scheduled(scheduledText(scheduled, now)), ctx) }],
				details: { ...scheduled, reason: params.reason, noop: params.noop },
			};
		},
	});

	pi.registerTool({
		name: "cron_create",
		label: "Cron Create",
		...ccToolRenderers<{ cron?: string }>("Cron Create", { title: (a) => a?.cron }),
		description: text.cron.createDescription({ maxAgeDays: RECURRING_MAX_AGE_DAYS }),
		parameters: cronParameters.create,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const result = cron.create({ cron: params.cron, prompt: params.prompt, recurring: params.recurring }, Date.now());
			if (!result.ok) return { content: [{ type: "text", text: text.cron.createFailed(result.failure) }], details: {}, isError: true };
			runCron();
			return {
				content: [{ type: "text", text: scheduling(created(result.job), ctx) }],
				details: { jobId: result.job.id, cron: result.job.cron, recurring: result.job.recurring, nextFireAt: result.job.nextFireAt },
			};
		},
	});

	pi.registerTool({
		name: "cron_list",
		label: "Cron List",
		...ccToolRenderers("Cron List"),
		description: text.cron.listDescription,
		parameters: cronParameters.list,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const jobs = cron.list();
			return { content: [{ type: "text", text: jobList(jobs) }], details: { count: jobs.length } };
		},
	});

	pi.registerTool({
		name: "cron_delete",
		label: "Cron Delete",
		...ccToolRenderers<{ id?: string }>("Cron Delete", { title: (a) => a?.id }),
		description: text.cron.deleteDescription,
		parameters: cronParameters.delete,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (!cron.delete(params.id)) return { content: [{ type: "text", text: text.cron.unknownJob({ id: params.id }) }], details: {}, isError: true };
			runCron();
			return { content: [{ type: "text", text: text.cron.deleted({ id: params.id }) }], details: { jobId: params.id } };
		},
	});

	// schedule_wakeup stays eager, as Claude Code's ScheduleWakeup is.
	for (const [name, keywords] of Object.entries({
		monitor: ["monitor", "watch", "background", "tail", "events", "stream", "websocket"],
		task_output: ["task", "background", "output", "status", "wait"],
		task_stop: ["task", "background", "stop", "kill", "cancel"],
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
			ctx.ui.notify(tasks.length ? tasks.map((task) => text.tasks.taskLine(shownTask(task))).join("\n") : "No background tasks.", "info");
		},
	});

	// `/loop` is a bundled skill whose body depends on its arguments; build it
	// for the skill extension (lib/plugins/skill-body.ts). Only our own SKILL.md: a
	// project skill named "loop" keeps its file's body.
	const loopSkillPath = join(BUNDLED_SKILLS_DIR, "loop", "SKILL.md");
	pi.events.on(SKILL_BODY_CHANNEL, (data) => {
		const query = data as SkillBodyQuery;
		if (query.skill !== "loop" || resolve(query.path) !== loopSkillPath) return;
		query.body = text.loop.skillBody({ form: loopSkillForm(query.args), loopFile: readLoopFile(query.cwd), persistent: loopPersistent(), maxAgeDays: RECURRING_MAX_AGE_DAYS });
	});

	/** Arm the branch's scheduled jobs, with each wakeup's loop age and keepalive spend. */
	const armFromBranch = (ctx: ExtensionContext) => {
		const now = Date.now();
		for (const job of scheduledJobsOnBranch(ctx.sessionManager.getBranch() as never)) {
			if (!cron.restore(job, now) || job.source !== "wakeup") continue;
			dynamicLoop.restoreChain(job.prompt, job.chainStartedAt ?? job.createdAt, job.fireAt ?? now, job.keepalive === true);
		}
		runCron();
	};
	// The jobs follow the branch: a /tree switch ends the abandoned branch's and
	// arms the selected one's (a subagent's own jobs stay with the agent).
	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		cron.deleteWhere((job) => job.agentId === undefined);
		dynamicLoop.clear();
		armFromBranch(ctx);
	});
	pi.on("session_start", (event, ctx) => {
		lastCtx = ctx;
		sessionCwd = ctx.cwd;
		// A /reload keeps the process and the conversation, so the session's
		// scheduled jobs come back from the branch (design.md section 13); a new
		// process ends them, as Claude Code's session-only jobs end.
		if (event.reason === "reload") armFromBranch(ctx);
		const pending = shutdownNotice();
		if (pending.text) {
			const notice = pending.text;
			pending.text = undefined;
			if (ctx.hasUI) queueNotice(pi.events, ctx, "info", notice);
		}
	});
	pi.on("agent_start", () => {
		agentBusy = true;
	});
	pi.on("agent_settled", () => {
		agentBusy = false;
		// Claude Code's keepalive: a wakeup's turn that scheduled no next one gets
		// one fallback, recorded so a /reload re-arms it (no tool result does).
		if (dynamicLoop.settle(Date.now()) === "armed") {
			const armed = cron.list().find((job) => job.source === "wakeup");
			if (armed) pi.appendEntry(WAKEUP_ARMED_ENTRY, { id: armed.id, prompt: armed.prompt, fireAt: armed.nextFireAt, startedAt: dynamicLoop.chainStart(armed.prompt) });
		}
		runCron();
	});
	// Folded no-op ticks leave the model's context (noop-fold.ts); the note stands in for them.
	pi.on("context", (event) => {
		const messages = applyNoopFolds(
			event.messages as Array<AgentMessage & { role: string }>,
			(note, timestamp) => ({ role: "user", content: [{ type: "text", text: note }], timestamp }) as AgentMessage & { role: string },
			text.loop.foldNote,
		);
		return messages ? { messages } : undefined;
	});
	// A switch stops everything below, so ask first. pi can cancel a switch but
	// not a quit; the widget line covers quitting (switch-guard.ts).
	const confirmSwitch = async (ctx: ExtensionContext, action: string): Promise<{ cancel: true } | undefined> => {
		if (!ctx.hasUI) return undefined;
		const title = switchWarning(
			registry.running().map((t) => ({ id: t.id, label: t.description })),
			cron.list().map((j) => ({ id: j.id, label: describeCadence(j.cron) })),
			action,
		);
		if (!title) return undefined;
		const choice = await ctx.ui.select(title, [SWITCH_CANCEL, SWITCH_STOP]);
		return choice === SWITCH_STOP ? undefined : { cancel: true };
	};
	pi.on("session_before_switch", (event, ctx) =>
		confirmSwitch(ctx, event.reason === "resume" ? "Resuming another session" : "Starting a new session"),
	);
	pi.on("session_before_fork", (_event, ctx) => confirmSwitch(ctx, "Forking the session"));

	pi.on("session_shutdown", (event) => {
		// Fires on /clear, /new, /resume and /reload too (findings §8). Everything
		// running dies with this instance — the replacement instance has no handle
		// on it — and the replacement is told (see shutdownNotice); a quit
		// needs no note. A reload keeps the conversation, so its note says so.
		const running = registry.running();
		// A reload re-arms the jobs from the branch: only the tasks stop.
		const jobs = event.reason === "reload" ? [] : cron.list();
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
			shutdownNotice().text = notices.join(" ");
		}
		registry.stopAll();
		cron.clear();
		dynamicLoop.clear();
		if (cronTimer) clearTimeout(cronTimer);
		cronTimer = undefined;
		lastCtx = undefined;
	});
}

export default feature("background", backgroundExtension);
