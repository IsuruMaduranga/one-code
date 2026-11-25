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
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { whenAborted } from "../../lib/core/abort.ts";
import { deferBaseTool } from "../../lib/request/deferred.ts";
import { persistedFilePreview, persistIfLarge, sessionResultsDir, taskOutputPath } from "../../lib/request/persisted-output.ts";
import { KILL_GRACE_MS, waitForChildExit } from "../../lib/shell-run/process-tree.ts";
import { sessionAlive } from "../../lib/notify/session-lifecycle.ts";
import { bashSpawn } from "../../lib/shell-run/shell-spawn.ts";
import { sandboxedCommand, type SandboxRun } from "../../lib/shell-run/sandbox.ts";
import { trackOriginalCommands } from "../../lib/shell/original-command.ts";
import { commandHosts } from "../../lib/shell-run/sandbox-settings.ts";
import { sandboxParams } from "../../lib/shell-run/shell-tool.ts";
import { ClickToggles, clickToExpand, dimMarkedLine, hiddenToolRenderers, shownLine, withResultDisplay, TURN_MARK, toolRenderers, customMessageText, expandHintFor, formatDuration, formatFireTime, notificationComponent, scheduledTaskComponent } from "../../lib/ui/tui-render.ts";
import {
	type BackgroundTask,
	BackgroundRegistry,
	generateTaskId,
	shownTask,
	TASK_REGISTER_CHANNEL,
} from "../../lib/agents/task-registry.ts";
import { SWITCH_CANCEL, SWITCH_STOP, switchWarning } from "./switch-guard.ts";
import { DynamicLoop, scheduledText } from "./wakeup.ts";
import { backgroundWords, type MonitorEnd, type MonitorStartFailure, type TaskToolsWords, type WakeupMissingField } from "./text.ts";
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
	handBackFlagBlock,
	TASK_COMPLETION_KEY,
	monitorEndedSummary,
	monitorEventSummary,
	oneShotNote,
	NOTIFICATION_HANDED_CHANNEL,
	NOTIFIER_BACKLOG_CHANNEL,
	type NotifierBacklogQuery,
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
import { requireText, toolLive } from "../../lib/profile/profile.ts";
import { textForModel } from "../../lib/agents/child-extensions.ts";
import { followDescriptionForm, registerVariantTool } from "../../lib/profile/tool-variants.ts";
import { toolsWithheldFrom, withOfferedTools } from "../../lib/models/model-family.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../../lib/plugins/skill-body.ts";
import { BUNDLED_SKILLS_DIR } from "../../lib/plugins/skill-scan.ts";
import { createWriteStream, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pendingWork, querySessionWork, SESSION_WORK_CHANNEL, sessionBackgroundTask, sessionCron, type SessionWorkQuery, waitingForText } from "../../lib/notify/session-work.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../../lib/agents/worktree-channel.ts";
import { queueNotice } from "../../lib/notify/notices.ts";
import { makeRecord, RECORD } from "../../lib/request/ledger/records.ts";
import { recordState, stateSinceCompaction } from "../../lib/request/ledger/state.ts";
import { processState } from "../../lib/profile/process-state.ts";
import { extensionVersion } from "../../lib/app/package-version.ts";
import { spawnOwnedShell, STORED_OUTPUT_CAP, tailCap } from "../../lib/shell-run/bash-background.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../../lib/request/reminders.ts";
import type { YieldEnd } from "./text.ts";
import { waitForBackground } from "./yield-wait.ts";

/** Claude Code's `task_output` limit (`TASK_MAX_OUTPUT_DEFAULT`). */
const TASK_OUTPUT_MAX_CHARS = 32_000;
const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
/** Claude Code 2.1.327's monitor deadlines: the schema accepts up to an hour, a longer one is capped to 30 minutes. */
const MAX_MONITOR_TIMEOUT_MS = 1_800_000;
const MONITOR_TIMEOUT_SCHEMA_MAX_MS = 3_600_000;
const MAX_BLOCK_TIMEOUT_MS = 600_000;
/**
 * Claude Code's monitor schema lists `timeout_ms` as required with a default,
 * and its validator fills a missing one, so its text says "default 5 minutes"
 * and its ws example leaves the field out. pi's validator treats `default` as
 * an annotation and rejects the call; this fills the default before
 * validation, keeping the schema's bytes.
 */
function withDefaultMonitorTimeout(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args) || (args as { timeout_ms?: unknown }).timeout_ms !== undefined) return args;
	return { ...args, timeout_ms: DEFAULT_MONITOR_TIMEOUT_MS };
}
/** A binary WebSocket frame's size, for Claude Code's `[binary frame, N bytes]` event line. */
function binaryFrameBytes(data: unknown): number {
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
	return 0;
}

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
 * `task_output`'s body. Past `TASK_OUTPUT_MAX_CHARS` a task with a spool file
 * gets Claude Code's clip, `[Truncated. Full output: <path>]` and the tail
 * that fits, since the file holds the full text; a task without one (a
 * subagent's report) is persisted whole to the session's tool-results
 * folder, never cut (decisions/tools.md).
 */
function taskOutputBody(task: BackgroundTask, ctx: ExtensionContext, text: TaskToolsWords): string {
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
	const text = backgroundWords(requireText("background"));
	const originalCommands = trackOriginalCommands(pi);
	const cronParameters = cronToolParameters(text.cron);
	const created = (job: CronJob) => text.cron.created({ job: shownJob(job), maxAgeDays: RECURRING_MAX_AGE_DAYS });
	const jobList = (jobs: CronJob[]) => text.cron.list({ jobs: jobs.map(shownJob) });
	/** A scheduling result, with the never-fires note in a one-shot run. */
	const scheduling = (result: string, ctx: ExtensionContext) => (sessionOutlivesTurn(ctx.mode) ? result : `${result} ${text.cron.neverFires}`);
	const monitorParams = text.monitor.params({ defaultTimeoutMs: DEFAULT_MONITOR_TIMEOUT_MS, maxTimeoutMs: MAX_MONITOR_TIMEOUT_MS });
	const spoolLost = text.monitor.spoolLost({ keptChars: STORED_OUTPUT_CAP });
	const unknownTask = (id: string) => ({
		content: [{ type: "text" as const, text: text.tasks.unknownTask({ id, known: registry.list().map((t) => ({ id: t.id, description: t.description })) }) }],
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
		query.wakeupPending ||= dynamicLoop.hasPending();
		query.tasks.push(...registry.running().map(sessionBackgroundTask));
	});

	// The wire frames are model-facing; the transcript shows a compact headline
	// instead (ctrl+o expands). One registration covers every emitter of
	// `task-notification` (bash uses it too). A fired wakeup or loop tick is the
	// prompt verbatim, shown behind Claude Code's "Running scheduled task" line.
	const clicked = new ClickToggles();
	pi.registerMessageRenderer("task-notification", (message, options, theme) =>
		clickToExpand(clicked, message, options.expanded, (expanded) => notificationComponent(theme, customMessageText(message.content), expanded, { hint: expandHintFor(options) })),
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
		if (!alive() || agentBusy) return;
		for (const fire of cron.takeDue(Date.now())) fireCron(fire);
		const next = cron.nextFireAt();
		if (next === undefined) return;
		cronTimer = setTimeout(runCron, Math.min(Math.max(0, next - Date.now()), MAX_TIMER_MS));
		cronTimer.unref?.();
	};

	const monitorTool = defineTool({
		name: "monitor",
		label: "Monitor",
		...toolRenderers("Monitor"),
		description: text.monitor.description,
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: monitorParams.command })),
			description: Type.String({ description: monitorParams.description }),
			timeout_ms: Type.Number({ minimum: 1000, maximum: MONITOR_TIMEOUT_SCHEMA_MAX_MS, default: DEFAULT_MONITOR_TIMEOUT_MS, description: monitorParams.timeoutMs }),
			// A command monitor may name hosts for itself, as a shell command may; it never asks to leave the sandbox.
			...sandboxParams(requireText("shell").sandbox, { leave: false }),
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
		prepareArguments: withDefaultMonitorTimeout as never,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const startFailed = (failure: MonitorStartFailure) => ({ content: [{ type: "text" as const, text: text.monitor.startFailed(failure) }], details: {}, isError: true });
			if (Boolean(params.command) === Boolean(params.ws)) return startFailed({ kind: "commandOrSocket" });
			if (params.ws && commandHosts(params).length > 0) return startFailed({ kind: "hostsNeedCommand" });
			// A monitor's command runs in the session's shell sandbox like any command the model starts.
			let command = params.command;
			const sandboxBash = bashSpawn().spawn?.shell;
			let sandboxRun: SandboxRun | undefined;
			if (command && sandboxBash) {
				// In a worktree session the command arrives wrapped for the worktree: the excluded patterns are matched
				// against the model's own command, and the sandbox is scoped to the directory it runs in.
				const original = originalCommands.get(toolCallId);
				const sandboxed = await sandboxedCommand({ command, original: original?.command ?? command, disable: false, cwd: original?.cwd ?? ctx.cwd, bash: sandboxBash, id: toolCallId });
				if ("refused" in sandboxed) {
					if (sandboxed.refused.kind === "hosts") return startFailed({ kind: "hostsRejected", reason: sandboxed.refused.reason });
					// `noBash` cannot happen here: the call above is made only with a bash.
					return startFailed({ kind: "sandboxRequired", reason: sandboxed.refused.kind === "unavailable" ? sandboxed.refused.reason : "it has not started" });
				}
				command = sandboxed.command;
				sandboxRun = sandboxed.run;
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
					const path = taskOutputPath(ctx, id);
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
			// The command's own host list ends with the monitor.
			void finished.then(() => sandboxRun?.finish());

			// `after` follows the batch's events: what the sandbox denied, on the batch that ends the monitor.
			const flush = (force = false, after = "") => {
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
				// CC's mid-run monitor batch: no status, the lines in `<event>`. The
				// batch forced out as the monitor ends belongs to its completion: the
				// end's own recent tail and task_output's result hold those lines.
				notify(
					"task-notification",
					taskNotification({ kind: "monitor", taskId: id, summary: monitorEventSummary(params.description), result: [formatMonitorEvents(id, batch, (more) => text.monitor.moreLines({ ...more, logPath: task.logPath })), after].filter(Boolean).join("\n") }),
					{ taskId: id, events: batchSize(batch), ...(force ? { [TASK_COMPLETION_KEY]: true } : {}) },
				);
			};

			// Set by stop(): what the command prints on stdout while it is torn down (a
			// shell running the rest of `sleep 30; echo done` before the SIGKILL grace
			// ends) is not an event, so the count says what happened before the stop.
			// Stderr is kept, since an error written just before the stop can still be
			// in the pipe; only bash's report of the job the stop killed is dropped.
			let stopRequested = false;
			// Set by the deadline: the end is Claude Code's expiry notice in the last
			// batch, not a "stopped" notification (findings §94).
			let expired = false;
			// The deadline timer, cleared the moment the monitor ends or is stopped:
			// `task.status` turns terminal only once the spool closes or the kill
			// grace ends, and an end or stop in that gap is not an expiry.
			let deadline: NodeJS.Timeout | undefined;
			let stderrWritten = false;
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
				clearTimeout(deadline);
				if (flushTimer) clearTimeout(flushTimer);
				const complete = () => {
					if (task.status !== "running") return;
					// Terminal status and its notification promise readable final output.
					task.status = finalStatus;
					task.finishedAt = Date.now();
					finish();
					// After shutdown or inside a one-shot run, report through `finished` alone.
					if (!alive() || oneShot) return;
					// What the sandbox denied the command rides its end, as a background shell's completion carries it.
					const denied = sandboxRun?.withViolations("").trim() ?? "";
					if (expired) {
						// The expiry line rides the monitor's last batch and is no event.
						const duration = formatDuration(0, timeoutMs).replace(/ 0[sm]$/, "");
						pushEvent(pending, text.monitor.expired({ duration, events: eventCount, stderrPath: stderrWritten ? task.logPath : undefined }));
						flush(true, denied);
						return;
					}
					flush(true);
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
							result: [recent, denied].filter(Boolean).join("\n") || undefined,
						}),
						{ taskId: id, status: finalStatus, [TASK_COMPLETION_KEY]: true },
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
				// An owned tree: stop() must end the COMMAND, not just the `$SHELL -c`
				// leader — with zsh a `cmd; echo` or a pipeline otherwise lives on as an
				// orphan holding the stdout pipe, so the task never finishes and, in a
				// one-shot run, the process cannot exit (LIFECYCLE-REVIEW M2, measured).
				// The session's bash (Git Bash on Windows) — lib/shell-run/shell-spawn.ts.
				const bash = bashSpawn();
				if (!bash.spawn) return startFailed({ kind: "noShell", osMessage: bash.error });
				const tree = spawnOwnedShell({ shell: bash.spawn, command: command ?? params.command, cwd: ctx.cwd });
				const child = tree.child;
				const lines = new MonitorLineSplitter();
				// Streaming decoders: a UTF-8 character split across reads stays whole.
				const stdoutText = new StringDecoder("utf8");
				const stderrText = new StringDecoder("utf8");
				child.stdout?.on("data", (chunk: Buffer) => {
					for (const line of lines.push(stdoutText.write(chunk))) onEvent(line);
				});
				const stderrRecord = (text: string) => {
					if (text) stderrWritten = true;
					record(stopRequested ? withoutJobReport(text) : text);
				};
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
						// A stopped monitor's exit code reports the kill, not the command (on Windows taskkill
						// always leaves 1), so its end names none, as a stopped background shell's does.
						end(stopRequested ? "stopped" : code === 0 ? "completed" : "failed", !stopRequested && code !== null && code !== 0 ? `exit code ${code}` : undefined);
					},
					(error: Error) => {
						drain();
						end("failed", error.message);
					},
				);
				stop = () => {
					stopRequested = true;
					clearTimeout(deadline);
					tree.stop(KILL_GRACE_MS);
				};
			} else {
				let ws: WebSocket;
				try {
					ws = new WebSocket(params.ws!.url, params.ws!.protocols);
				} catch (error) {
					return startFailed({ kind: "socketFailed", url: params.ws!.url, osMessage: (error as Error).message });
				}
				ws.addEventListener("message", (event) => {
					onEvent(typeof event.data === "string" ? event.data : `[binary frame, ${binaryFrameBytes(event.data)} bytes]`);
				});
				ws.addEventListener("error", () => end("failed", "websocket error"));
				ws.addEventListener("close", () => end(stopRequested ? "stopped" : "completed", "socket closed"));
				stop = () => {
					stopRequested = true;
					clearTimeout(deadline);
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
			// path).
			if (!oneShot) registry.register(task);

			const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS, MAX_MONITOR_TIMEOUT_MS);
			deadline = setTimeout(() => {
				if (status !== "running" || stopRequested) return;
				// stop() clears the timer: mark the expiry after it.
				stop();
				expired = true;
			}, timeoutMs);
			deadline.unref?.();

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
				const shown = spooled ?? persistIfLarge(kept, { dir: sessionResultsDir(ctx), id: `monitor-${id}` });
				// What the sandbox denied the command follows its events.
				const output = sandboxRun ? sandboxRun.withViolations(shown) : shown;
				const finalStatus = task.status;
				const end: MonitorEnd =
					finalStatus !== "stopped"
						? { kind: finalStatus === "failed" ? "failed" : "completed" }
						: signal?.aborted
							? { kind: "aborted" }
							: { kind: "deadline", ms: timeoutMs };
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
	// Registered again when the session's model changes whether it is offered yield (followDescriptionForm below).
	const setMonitorDescription = registerVariantTool<string>(pi, monitorTool.description, (description) => ({ ...monitorTool, description }));

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		...toolRenderers("Task Output"),
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

			// An agent reports through its task notification only: a call on a
			// running one returns at once and says so, whatever `block` asks,
			// so a wait for the report never becomes a poll.
			if (task.kind === "subagent" && task.status === "running") {
				return {
					content: [{ type: "text", text: `${text.tasks.taskLine(shownTask(task))}\n\n${text.tasks.agentStillRunning}` }],
					// Claude Code's dim row for a running task; the model also reads how to wait.
					details: { taskId: task.id, status: task.status, logPath: task.logPath, ...shownLine("Task is still running…") },
				};
			}

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

			const header = text.tasks.taskLine(shownTask(task));
			// A finished task's output is always returned here; its completion
			// notification is withdrawn where pi does not hold it yet
			// (lib/notify/notifications.ts TASK_OUTPUT_DELIVERED_CHANNEL).
			if (task.status !== "running") pi.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: task.id } satisfies TaskOutputDelivered);
			const body = taskOutputBody(task, ctx, text.tasks) || text.tasks.noOutputYet;
			// A flagged agent turn: auto mode's warning comes with the report, as
			// on the hand-back and the foreground Agent result.
			const flag = task.reviewWarning ? [{ type: "text" as const, text: handBackFlagBlock(task.reviewWarning) }] : [];
			return {
				content: [...flag, { type: "text", text: `${header}\n\n${body}` }],
				details: { taskId: task.id, status: task.status, logPath: task.logPath },
			};
		},
	});

	// yield is active only for a model it is offered to; the monitor description names it only then.
	const followModel = (model: Model<Api> | undefined) => {
		const active = pi.getActiveTools();
		const next = withOfferedTools(active, ["yield"], toolsWithheldFrom(model), toolLive);
		if (next !== active) pi.setActiveTools([...next]);
	};
	pi.on("session_start", (_event, ctx) => followModel(ctx.model));
	pi.on("model_select", (event) => followModel(event.model));
	// pi restores the selected branch's tool loadout at a /tree switch.
	pi.on("session_tree", (_event, ctx) => followModel(ctx.model));
	followDescriptionForm(pi, (_form, _tier, withheld) => setMonitorDescription(textForModel("background", withheld).monitor.description));

	// A session ending mid-wait ends the wait too, so nothing polls a dead session.
	let sessionEnded = new AbortController();
	pi.on("session_shutdown", () => sessionEnded.abort());
	pi.on("session_start", () => {
		if (sessionEnded.signal.aborted) sessionEnded = new AbortController();
	});

	// One wait per reply, as in Claude Code: a second yield in the same reply returns at once.
	let yieldedInReply = false;
	pi.on("message_start", (event) => {
		if ((event.message as { role?: string }).role === "assistant") yieldedInReply = false;
	});

	// Claude Code 2.1.327's flagged `Yield` (findings §94), offered to every
	// model outside the Claude family (lib/models/model-family.ts toolsWithheldFrom):
	// one blocking call for a model that wants to wait for an agent, a shell or
	// a monitor, instead of polling. It ends when a notification is handed to pi
	// (delivered right after this result), the user queues a message, a
	// scheduled prompt is due, nothing is left that could report, the call is
	// aborted, or the cap passes; the reason rides the result as a reminder.
	// The TUI draws its row as the dim "✻ Waiting for 1 background agent to
	// finish" line a turn ends with while agents still run (ui/turn-duration),
	// and hides pi's working line while it waits: waiting inside a turn and
	// after one look the same, since in both whatever the user types reaches
	// the model.
	const yieldLabel = "Wait for background work";
	const yieldHidden = hiddenToolRenderers(yieldLabel);
	pi.registerTool({
		name: "yield",
		label: yieldLabel,
		...yieldHidden,
		renderResult: (result, options, theme, context) => {
			const waiting = (result?.details as { waiting?: string } | undefined)?.waiting;
			return waiting && !context.isError ? dimMarkedLine(theme, TURN_MARK, waiting) : yieldHidden.renderResult(result, options, theme, context);
		},
		description: text.yield.description,
		parameters: Type.Object({}),
		// After an Agent or bash call in the same reply, so the work it waits for is registered.
		executionMode: "sequential",
		async execute(toolCallId, _params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const startedAt = Date.now();
			let end: YieldEnd;
			let waiting: string | undefined;
			if (yieldedInReply) end = { kind: "duplicate" };
			// A one-shot run blocks on every agent and shell: nothing is in the background to wait for.
			else if (!sessionOutlivesTurn(ctx.mode)) end = { kind: "nothingRunning" };
			else {
				yieldedInReply = true;
				// The row's line, drawn now as a partial result and kept in the final one.
				waiting = waitingForText(pendingWork(pi.events));
				// The row replaces pi's working line, so hide it only when there is a row. Nothing
				// else hides that line, so the finally shows it again rather than restoring a saved state.
				const hide = waiting !== undefined && ctx.hasUI;
				if (waiting) onUpdate?.({ content: [], details: { waiting } });
				if (hide) ctx.ui.setWorkingVisible(false);
				try {
					end = await waitForBackground(
						{
							backlog: () => {
								const query: NotifierBacklogQuery = { coalescing: 0, handed: 0 };
								pi.events.emit(NOTIFIER_BACKLOG_CHANNEL, query);
								return query;
							},
							// Every extension's running work: registry tasks, workflow runs, and
							// residents busy on a later turn (lib/notify/session-work.ts).
							running: () => querySessionWork(pi.events).tasks.length,
							userMessageQueued: () => ctx.hasPendingMessages(),
							// Only a main-session job starts a turn here; a subagent's job fires into the agent.
							scheduledDue: () => {
								const now = Date.now();
								return cron.list().some((job) => job.agentId === undefined && job.nextFireAt <= now);
							},
							onHanded: (listener) => pi.events.on(NOTIFICATION_HANDED_CHANNEL, listener),
						},
						signal ? AbortSignal.any([signal, sessionEnded.signal]) : sessionEnded.signal,
					);
				} finally {
					if (hide) ctx.ui.setWorkingVisible(true);
				}
			}
			const resumed = text.yield.resumed({ waitedMs: Date.now() - startedAt, end });
			pi.events.emit(REMINDER_CHANNEL, { text: resumed, toolCallId } satisfies ReminderPayload);
			return { content: [{ type: "text", text: text.yield.ended }], details: { end: end.kind, waiting } };
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop Task",
		// Claude Code's "<task> · stopped"; the model reads which task and how it ended.
		...withResultDisplay(toolRenderers("Stop Task"), (result) => {
			const stopped = (result.details as { stopped?: string } | undefined)?.stopped;
			return stopped === undefined ? undefined : `${stopped} · stopped`;
		}),
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
			return {
				content: [
					{
						type: "text",
						text: wasResident
							? text.tasks.residentEnded({ id: task.id, description: task.description })
							: text.tasks.stopRequested({ id: task.id, description: task.description }),
					},
				],
				details: { taskId: task.id, stopped: task.description },
			};
		},
	});

	pi.registerTool({
		name: "schedule_wakeup",
		label: "Schedule Wakeup",
		...toolRenderers<{ delaySeconds?: number; stop?: boolean }>("Schedule Wakeup", {
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
				return { content: [{ type: "text", text: text.wakeup.stopped({ cancelled }) }], details: { stopped: true, cancelledWakeups: cancelled, ...shownLine("Loop stopped") } };
			}
			if (params.delaySeconds === undefined || params.reason === undefined) return fail("delayAndReason");
			if (params.prompt === undefined) return fail("prompt");
			if (params.noop === undefined) return fail("noop");
			const now = Date.now();
			const scheduled = dynamicLoop.schedule(params.delaySeconds, params.prompt, now);
			runCron();
			if (!scheduled) return { content: [{ type: "text", text: text.wakeup.agedOut }], details: { scheduledFor: 0, ...shownLine("Loop ended: it reached its maximum duration") } };
			const when = scheduledText(scheduled, now);
			return {
				content: [{ type: "text", text: scheduling(text.wakeup.scheduled(when), ctx) }],
				details: { ...scheduled, reason: params.reason, noop: params.noop, ...shownLine(`Next wakeup at ${when.clock} (in ${formatDuration(0, when.inSeconds * 1000)})`) },
			};
		},
	});

	pi.registerTool({
		name: "cron_create",
		label: "Cron Create",
		...toolRenderers<{ cron?: string }>("Cron Create", { title: (a) => a?.cron }),
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
		...toolRenderers("Cron List"),
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
		...toolRenderers<{ id?: string }>("Cron Delete", { title: (a) => a?.id }),
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
	deferBaseTool(pi.events, "monitor", ["monitor", "watch", "background", "tail", "events", "stream", "websocket"]);
	deferBaseTool(pi.events, "task_output", ["task", "background", "output", "status", "wait"]);
	deferBaseTool(pi.events, "task_stop", ["task", "background", "stop", "kill", "cancel"]);
	deferBaseTool(pi.events, "cron_create", ["cron", "schedule", "recurring", "remind", "timer", "every", "later"]);
	deferBaseTool(pi.events, "cron_list", ["cron", "schedule", "list", "jobs", "scheduled"]);
	deferBaseTool(pi.events, "cron_delete", ["cron", "schedule", "cancel", "delete", "stop"]);

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
	// Everything a switch or a reload stops, from the one list every extension
	// answers into: the registry's tasks (this extension's own answer) and the
	// work that never enters the registry (a running workflow, a resident
	// agent's turn that no task covers).
	const runningWork = (): Array<{ id: string; description: string }> =>
		querySessionWork(pi.events)
			.tasks.filter((task) => task.status === "running")
			.map(({ id, description }) => ({ id, description }));
	// A switch stops everything below, so ask first. pi can cancel a switch but
	// not a quit; the /tasks dialog says that quitting stops it (switch-guard.ts).
	const confirmSwitch = async (ctx: ExtensionContext, action: string): Promise<{ cancel: true } | undefined> => {
		if (!ctx.hasUI) return undefined;
		const title = switchWarning(
			runningWork().map((t) => ({ id: t.id, label: t.description })),
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
		const running = runningWork();
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
