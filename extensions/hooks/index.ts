/**
 * hooks extension — Claude Code-compatible command hooks.
 *
 * Reads CC hook config (user/managed .claude settings always; project/local
 * after a once-per-config consent — trust.ts; plugin hooks/hooks.json as user
 * scope), matches CC-style matchers against tool calls and lifecycle events,
 * runs the commands with the CC stdin/stdout protocol (protocol.ts,
 * executor.ts), and applies the verdicts.
 *
 * Position in package.json pi.extensions is load-bearing: this extension must
 * run its tool_call handler BEFORE worktree/file-tracker/permissions, so hook
 * matchers and updatedInput see the tool call as the model produced it, and
 * everything downstream — including the permission gate, safety floor, and
 * auto-mode classifier — evaluates the hook-rewritten input (CC semantics).
 *
 * A hook can block anything, loaders included (tool_search/skill/
 * structured_output) — full CC fidelity, the user's config is the user's
 * choice; see docs/findings.md for the foot-gun note. A hook can never
 * pre-approve: "allow" is informational and the permission gate still runs.
 *
 * pi's emitToolCall has no try/catch around handlers, so every hook dispatch
 * here is wrapped — a throwing hook fails open, never takes the turn down.
 *
 * Hook context reaches the model in Claude Code's `hook_additional_context`
 * shape — a `<system-reminder>` reading "<Event> hook additional context: …" —
 * never as a message of its own: PreToolUse context is queued as a one-shot on
 * the reminder channel, so it lands INSIDE the tool result it belongs to,
 * persisted, at no extra turn; PostToolUse context is appended to the result
 * the same way; prompt/session/compaction context is returned from
 * `before_agent_start` as a custom message right AFTER the user's prompt. Until
 * 2026-09-05 each was a custom steer (one extra LLM turn per hook per tool,
 * pi draining one steer per call) and prompt context landed BEFORE the prompt
 * (STEERING-REVIEW-2026-09-05 M6).
 *
 * Subagents: the tool hooks also run for a child's tool calls, through the
 * bridge published on `SUBAGENT_HOOK_CHANNEL` (subagent-bridge.ts): the child
 * calls back into this extension, which dispatches with the parent's context
 * (settings, consent, logging) and a payload naming the child.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RunOutcomeLatch } from "../lib/interrupt.ts";
import { claudeConfigDir } from "../lib/paths.ts";
import { defaultDiscoverRoots } from "../lib/plugins.ts";
import { appendHookLog, formatDebugLine, hooksDebugEnabled, hooksLogPath } from "./debug.ts";
import { runHookCommand } from "./executor.ts";
import { changedSince, FORMATTER_NOTICE, type FileSnapshot, fileToolTarget, snapshotFile } from "./formatter-notice.ts";
import { matcherApplies, ccToolName, toolMatchCandidates, ccToolInput, nativeToolInput } from "./matcher.ts";
import { loadPluginHooks } from "./plugin-hooks.ts";
import {
	applyPostToolUseOutcome,
	type CcHookEvent,
	type HookOutcome,
	type HookStdinPayload,
	interpretHookResult,
} from "./protocol.ts";
import { type HookCommand, type HooksSource, loadHookSettings } from "./settings.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { REMINDER_CHANNEL, wrapReminder } from "../lib/reminders.ts";
import { type ChildHookCall, type ChildHookResult, type HookBridge, SUBAGENT_HOOK_CHANNEL, type SubagentHookPayload } from "./subagent-bridge.ts";
import { projectHooksApproved } from "./trust.ts";

/** Claude Code's `hook_additional_context` attachment text (utils/messages.ts). */
export function hookContextText(event: CcHookEvent, text: string): string {
	return `${event} hook additional context: ${text}`;
}

/**
 * Hook text that reaches the model (additionalContext, a string updatedToolResult)
 * is bounded: the executor allows 1 MB per stream, and a runaway hook would
 * otherwise dump all of it into context (review T5). Past the cap the full text
 * is PERSISTED under the session's tool-results (Claude Code's convention) and
 * the model gets a preview plus the path — nothing is cut away.
 */
const HOOK_MODEL_TEXT_CAP = 20_000;
function capHookText(text: string, ctx: HookDispatchCtx, label: string): string {
	return persistIfLarge(text, { dir: sessionResultsDir(ctx), id: `hook-${label}-${Date.now()}`, maxBytes: HOOK_MODEL_TEXT_CAP });
}

interface MatchedHook {
	source: HooksSource;
	hook: HookCommand;
}

/**
 * What the hook pipeline reads off a context — the live `ExtensionContext` is
 * assignable, and a SessionEnd dispatch runs on a snapshot of the same shape
 * (see `shutdownCtx`) after the real one has been disposed.
 */
interface HookDispatchCtx {
	cwd: string;
	hasUI: boolean;
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getSessionDir?(): string | undefined };
	ui: { confirm(title: string, message: string): Promise<boolean | undefined>; notify(message: string, type: "info"): void };
	/** Set on the shutdown snapshot: no consent prompt, no notices — the session is gone. */
	sessionEnded?: true;
}

export default function hooksExtension(pi: ExtensionAPI) {
	let stopHookActive = false;
	/** Context from UserPromptSubmit / SessionStart / PostCompact hooks, delivered with the next prompt. */
	let pendingPromptContext: Array<{ event: CcHookEvent; text: string }> = [];
	/** The last context seen, for bridged child calls (dispatched parent-side). */
	let lastCtx: ExtensionContext | undefined;

	const notify = (ctx: HookDispatchCtx, message: string) => {
		if (ctx.sessionEnded) return; // session gone; nowhere to show it
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		else process.stderr.write(`${message}\n`);
	};

	/** All hooks for an event across trusted sources, matcher already applied. */
	const collectHooks = async (
		ctx: HookDispatchCtx,
		event: CcHookEvent,
		matchValue: { candidates?: string[]; ignoreMatcher?: boolean },
	): Promise<MatchedHook[]> => {
		const claudeDir = claudeConfigDir();
		const loaded = loadHookSettings(claudeDir, ctx.cwd);
		const pluginSources = loadPluginHooks(defaultDiscoverRoots(getAgentDir(), ctx.cwd), loaded.diagnostics);
		if (hooksDebugEnabled()) {
			for (const diagnostic of loaded.diagnostics) process.stderr.write(`[hooks] ${diagnostic}\n`);
		}

		const projectSources = loaded.sources.filter((s) => s.scope === "project" || s.scope === "local");
		const hasProjectHooks = projectSources.some((s) => s.config[event]?.length);
		let projectAllowed = true;
		if (hasProjectHooks) {
			projectAllowed = await projectHooksApproved(ctx.cwd, projectSources, {
				hasUI: ctx.hasUI,
				noPrompt: ctx.sessionEnded,
				confirm: (title, message) => ctx.ui.confirm(title, message),
				notify: (message) => notify(ctx, message),
			});
		}

		const sources = [
			...loaded.sources.filter((s) => s.scope === "user" || s.scope === "managed"),
			...pluginSources,
			...(projectAllowed ? projectSources : []),
		];

		const matched: MatchedHook[] = [];
		for (const source of sources) {
			for (const entry of source.config[event] ?? []) {
				const applies = matchValue.ignoreMatcher || matcherApplies(entry.matcher, matchValue.candidates ?? []);
				if (!applies) continue;
				for (const hook of entry.hooks) matched.push({ source, hook });
			}
		}
		return matched;
	};

	const basePayload = (ctx: HookDispatchCtx, event: CcHookEvent): HookStdinPayload => ({
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: ctx.sessionManager.getSessionFile() ?? "",
		cwd: ctx.cwd,
		hook_event_name: event,
	});

	/**
	 * Run every matched hook in parallel (CC runs matching hooks concurrently)
	 * and merge: first block wins, updatedInput merges in order, contexts and
	 * systemMessages concatenate. Any throw inside is caught → fail open.
	 */
	const dispatch = async (
		ctx: HookDispatchCtx,
		event: CcHookEvent,
		matchValue: { candidates?: string[]; ignoreMatcher?: boolean },
		payload: HookStdinPayload,
		/** Runs once, only when hooks will actually run — the point where a caller can snapshot state the hooks may change. */
		willRun?: () => void,
	): Promise<HookOutcome> => {
		const merged: HookOutcome = {};
		try {
			const hooks = await collectHooks(ctx, event, matchValue);
			if (hooks.length === 0) return merged;
			willRun?.();
			const stdin = JSON.stringify(payload);
			const outcomes = await Promise.all(
				hooks.map(async ({ source, hook }) => {
					const run = await runHookCommand(hook.command, stdin, {
						cwd: ctx.cwd,
						timeoutSeconds: hook.timeout,
						projectDir: ctx.cwd,
						// SessionEnd is fire-and-forget at shutdown: it must not hold a
						// one-shot process open. Every other hook is awaited work that
						// must (executor.ts, the event-loop drain).
						detached: event === "SessionEnd",
					});
					const outcome = interpretHookResult(event, run);
					const decision = outcome.block ? "block" : outcome.additionalContext ? "context" : run.exitCode === 0 || run.exitCode === 2 ? "allow" : "error";
					const logEntry = {
						event,
						scope: source.pluginName ? `plugin:${source.pluginName}` : source.scope,
						command: hook.command,
						decision: decision as "allow" | "block" | "context" | "error",
						reason: outcome.block?.reason,
						exitCode: run.exitCode,
						durationMs: run.durationMs,
					};
					if (hooksDebugEnabled()) process.stderr.write(`${formatDebugLine(logEntry)}\n`);
					if (process.env.CC_HOOKS_DEBUG === "2") {
						appendHookLog({ ts: new Date().toISOString(), sessionId: payload.session_id, ...logEntry }, hooksLogPath());
					}
					return outcome;
				}),
			);
			for (const outcome of outcomes) {
				merged.block ??= outcome.block;
				if (outcome.updatedInput) merged.updatedInput = { ...merged.updatedInput, ...outcome.updatedInput };
				if ("updatedToolResult" in outcome) {
					merged.updatedToolResult =
						typeof outcome.updatedToolResult === "string" ? capHookText(outcome.updatedToolResult, ctx, `${event}-result`) : outcome.updatedToolResult;
				}
				if (outcome.additionalContext) {
					merged.additionalContext = capHookText(
						[merged.additionalContext, outcome.additionalContext].filter(Boolean).join("\n"),
						ctx,
						`${event}-context`,
					);
				}
				if (outcome.systemMessage) {
					merged.systemMessage = [merged.systemMessage, outcome.systemMessage].filter(Boolean).join("\n");
				}
			}
		} catch (error) {
			// Fail open: a broken hook pipeline must never take the turn down.
			if (hooksDebugEnabled()) {
				process.stderr.write(`[hooks] dispatch error (${event}): ${error instanceof Error ? error.message : error}\n`);
			}
		}
		if (merged.systemMessage) notify(ctx, merged.systemMessage);
		return merged;
	};

	// ---- PreToolUse ---------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		const payload: HookStdinPayload = {
			...basePayload(ctx, "PreToolUse"),
			tool_name: ccToolName(event.toolName),
			tool_input: ccToolInput(event.toolName, event.input as Record<string, unknown>),
		};
		const outcome = await dispatch(ctx, "PreToolUse", { candidates: toolMatchCandidates(event.toolName) }, payload);
		if (outcome.block) return { block: true, reason: `PreToolUse hook: ${outcome.block.reason}` };
		if (outcome.updatedInput) {
			// In-place, so worktree/file-tracker/permissions (later in the
			// extension order) all see the rewritten input — CC applies hook
			// input updates before permission evaluation. The hook answered in
			// CC's parameter names; translate back to the tool's own.
			Object.assign(event.input as Record<string, unknown>, nativeToolInput(event.toolName, outcome.updatedInput));
		}
		// A one-shot pending when this call's result is stored is written into
		// that result by the system-reminder extension — CC's shape, no extra turn.
		if (outcome.additionalContext) pi.events.emit(REMINDER_CHANNEL, { text: hookContextText("PreToolUse", outcome.additionalContext) });
		return undefined;
	});

	// ---- PostToolUse --------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		const payload: HookStdinPayload = {
			...basePayload(ctx, "PostToolUse"),
			tool_name: ccToolName(event.toolName),
			tool_input: ccToolInput(event.toolName, event.input as Record<string, unknown>),
			tool_response: { content: event.content, is_error: event.isError },
		};
		// A hook that rewrites the file the model just edited is otherwise invisible
		// to it: this extension awaits the hook and loads before file-tracker, so
		// the tracker records the hook's version as the model's own write
		// (formatter-notice.ts, review M1). Snapshot only when hooks will run.
		const target = event.isError ? undefined : fileToolTarget(event.toolName, event.input, ctx.cwd);
		let before: FileSnapshot | undefined;
		const outcome = await dispatch(ctx, "PostToolUse", { candidates: toolMatchCandidates(event.toolName) }, payload, () => {
			if (target) before = snapshotFile(target);
		});
		const formatterNotice = target && before && changedSince(target, before) ? wrapReminder(FORMATTER_NOTICE(target)) : undefined;
		// CC feeds PostToolUse block reasons back to the model in the result the
		// same way; the assembly rules live in applyPostToolUseOutcome.
		const content = applyPostToolUseOutcome(event.content, {
			...outcome,
			additionalContext:
				[outcome.additionalContext && wrapReminder(hookContextText("PostToolUse", outcome.additionalContext)), formatterNotice]
					.filter(Boolean)
					.join("\n") || undefined,
		});
		if (!content) return undefined;
		return { content, isError: event.isError };
	});

	// ---- UserPromptSubmit ---------------------------------------------------
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return undefined;
		stopHookActive = false;
		const payload: HookStdinPayload = { ...basePayload(ctx, "UserPromptSubmit"), prompt: event.text };
		const outcome = await dispatch(ctx, "UserPromptSubmit", { ignoreMatcher: true }, payload);
		if (outcome.block) {
			notify(ctx, `Prompt blocked by UserPromptSubmit hook: ${outcome.block.reason}`);
			return { action: "handled" as const };
		}
		if (outcome.additionalContext) pendingPromptContext.push({ event: "UserPromptSubmit", text: outcome.additionalContext });
		return undefined;
	});

	// Prompt/session/compaction hook context rides the turn it belongs to as a
	// custom message pi appends right AFTER the user's prompt (the
	// before_agent_start `message` return). An idle `sendMessage` from here
	// landed it BEFORE the prompt (pi appends first, then adds the user message).
	pi.on("before_agent_start", (_event, ctx) => {
		lastCtx = ctx;
		if (pendingPromptContext.length === 0) return;
		const texts = pendingPromptContext;
		pendingPromptContext = [];
		return {
			message: {
				customType: "one-code:hook-context",
				content: texts.map(({ event, text }) => wrapReminder(hookContextText(event, text))).join("\n"),
				display: false,
			},
		};
	});

	// ---- SessionStart / SessionEnd -----------------------------------------
	const dispatchSessionStart = async (ctx: ExtensionContext, source: string) => {
		const payload: HookStdinPayload = { ...basePayload(ctx, "SessionStart"), source };
		const outcome = await dispatch(ctx, "SessionStart", { candidates: [source] }, payload);
		if (outcome.additionalContext) pendingPromptContext.push({ event: "SessionStart", text: outcome.additionalContext });
	};

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		pendingPromptContext = [];
		// Publish the child hook bridge (subagent-bridge.ts). The closures read
		// live parent state per call, so once per session start is enough.
		pi.events.emit(SUBAGENT_HOOK_CHANNEL, { bridge: childHookBridge } satisfies SubagentHookPayload);
		// Claude Code's sources are startup | resume | clear | compact; pi's
		// `new` (/clear, /new) is a clear — the process-launch case arrives as
		// `startup` already. `compact` is dispatched from session_compact below.
		const reason = (event as { reason?: string }).reason ?? "startup";
		if (reason === "reload" || reason === "fork") return;
		await dispatchSessionStart(ctx, reason === "new" ? "clear" : reason);
	});

	// ---- Subagent bridge ----------------------------------------------------
	/** A child's payload: the child's identity, the parent's config and consent. */
	const childPayload = (call: ChildHookCall, event: CcHookEvent): HookStdinPayload => ({
		session_id: call.sessionId ?? "",
		transcript_path: call.transcriptPath ?? "",
		cwd: call.cwd,
		hook_event_name: event,
		tool_name: ccToolName(call.toolName),
		tool_input: ccToolInput(call.toolName, call.input),
		agent_id: call.sessionId,
		agent_type: call.agentType,
	});
	const childHookBridge: HookBridge = {
		async preToolUse(call) {
			const ctx = lastCtx;
			if (!ctx) return {};
			const outcome = await dispatch(ctx, "PreToolUse", { candidates: toolMatchCandidates(call.toolName) }, childPayload(call, "PreToolUse"));
			return {
				block: outcome.block,
				updatedInput: outcome.updatedInput ? nativeToolInput(call.toolName, outcome.updatedInput) : undefined,
				additionalContext: outcome.additionalContext ? hookContextText("PreToolUse", outcome.additionalContext) : undefined,
			};
		},
		async postToolUse(result: ChildHookResult) {
			const ctx = lastCtx;
			if (!ctx) return {};
			const payload: HookStdinPayload = {
				...childPayload(result, "PostToolUse"),
				tool_response: { content: result.content, is_error: result.isError },
			};
			const target = result.isError ? undefined : fileToolTarget(result.toolName, result.input, ctx.cwd);
			let before: FileSnapshot | undefined;
			const outcome = await dispatch(ctx, "PostToolUse", { candidates: toolMatchCandidates(result.toolName) }, payload, () => {
				if (target) before = snapshotFile(target);
			});
			const formatterNotice = target && before && changedSince(target, before) ? wrapReminder(FORMATTER_NOTICE(target)) : undefined;
			return {
				block: outcome.block,
				updatedToolResult: outcome.updatedToolResult,
				additionalContext:
					[outcome.additionalContext && wrapReminder(hookContextText("PostToolUse", outcome.additionalContext)), formatterNotice]
						.filter(Boolean)
						.join("\n") || undefined,
			};
		},
	};

	pi.on("session_shutdown", (event, ctx) => {
		// A reload re-runs the extensions but keeps the conversation (pi's
		// AgentSession.reload): not a session end, Claude Code has no such event.
		if (event.reason === "reload") return;
		// Claude Code's SessionEnd carries `reason`: clear | logout | prompt_input_exit
		// | other. pi's `new` (/clear, /new) is a clear; a `quit` from the TUI is the
		// user leaving the prompt; a headless run's end, a resume and a fork are
		// `other` (LIFECYCLE-REVIEW-2026-09-06 M4).
		const reason = event.reason === "new" ? "clear" : event.reason === "quit" && ctx.hasUI ? "prompt_input_exit" : "other";
		const payload: HookStdinPayload = { ...basePayload(ctx, "SessionEnd"), reason };
		// Fire and forget: the process is on its way out; nothing to apply. The ctx
		// is frozen first: after this handler returns pi disposes the session and
		// every getter on the real ctx throws, so a dispatch that awaited (the
		// project-hooks consent read) would then fail inside its own try and the
		// hook silently would not run. Consent is never PROMPTED at shutdown: a
		// project config that was never approved is skipped, as in headless runs.
		void dispatch(shutdownCtx(ctx), "SessionEnd", { ignoreMatcher: true }, payload);
	});

	/** The subset of ctx `dispatch` reads, snapshotted so it survives the session's disposal. */
	const shutdownCtx = (ctx: ExtensionContext): HookDispatchCtx => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = ctx.sessionManager.getSessionDir();
		return {
			sessionEnded: true,
			cwd: ctx.cwd,
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getSessionDir: () => sessionDir },
			ui: { confirm: async () => false, notify: () => {} },
		};
	};

	// ---- Stop ---------------------------------------------------------------
	// agent_settled, not agent_end: CC fires Stop once, when the main agent has
	// finished responding, and a turn can hold several runs (`lib/interrupt.ts`).
	// Dispatching per run would run the user's Stop hook several times per turn and
	// let a blocking hook inject its follow-up mid-retry.
	const stopOutcome = new RunOutcomeLatch();
	pi.on("agent_end", (event, ctx) => {
		stopOutcome.record(event.messages, ctx.signal?.aborted);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// CC skips Stop when the turn ended on an API error (a blocking hook would
		// spiral: error → block → retry → error) or on a user interrupt (its query
		// loop returns on the abort signal before the stop-hook step). An empty latch
		// means no run ended in this turn, which is not a response to stop on either.
		if (stopOutcome.take() !== "ok") return;
		const payload: HookStdinPayload = { ...basePayload(ctx, "Stop"), stop_hook_active: stopHookActive };
		const outcome = await dispatch(ctx, "Stop", { ignoreMatcher: true }, payload);
		if (!outcome.block) return;
		stopHookActive = true;
		try {
			pi.sendMessage(
				{
					customType: "one-code:hook-stop",
					content: `Stop hook blocked stopping: ${outcome.block.reason}`,
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// Session is gone; nothing to continue.
		}
	});

	// ---- PreCompact / PostCompact ------------------------------------------
	// Claude Code's trigger is manual | auto; pi's threshold and overflow
	// reasons are both `auto`. Both payloads mirror CC's PreCompactHookInput /
	// PostCompactHookInput field for field.
	const compactTrigger = (event: { reason?: string }): "manual" | "auto" => (event.reason === "manual" ? "manual" : "auto");

	pi.on("session_before_compact", async (event, ctx) => {
		const trigger = compactTrigger(event);
		const payload: HookStdinPayload = {
			...basePayload(ctx, "PreCompact"),
			trigger,
			custom_instructions: event.customInstructions ?? "",
		};
		const outcome = await dispatch(ctx, "PreCompact", { candidates: [trigger] }, payload);
		if (outcome.block) {
			notify(ctx, `Compaction cancelled by PreCompact hook: ${outcome.block.reason}`);
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("session_compact", async (event, ctx) => {
		const trigger = compactTrigger(event);
		const payload: HookStdinPayload = {
			...basePayload(ctx, "PostCompact"),
			trigger,
			compact_summary: event.compactionEntry.summary,
		};
		const outcome = await dispatch(ctx, "PostCompact", { candidates: [trigger] }, payload);
		if (outcome.additionalContext) pendingPromptContext.push({ event: "PostCompact", text: outcome.additionalContext });
		// CC fires SessionStart(source: "compact") after compaction.
		await dispatchSessionStart(ctx, "compact");
	});
}
