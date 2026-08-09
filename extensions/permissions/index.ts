/**
 * permissions extension — Claude Code-style permission system.
 *
 * - Rules from ~/.claude/settings.json + <project>/.claude/settings.json +
 *   settings.local.json (Claude Code format, PascalCase tool names accepted).
 * - Modes: default (manual) | acceptEdits | plan | auto | bypassPermissions |
 *   dontAsk, set via --permission-mode / --dangerously-skip-permissions, and
 *   cycled with ctrl+q (Claude Code uses shift+tab, which pi reserves for the
 *   thinking dial). The cycle is manual → accept edits → plan → [bypass] →
 *   [auto], matching Claude Code's order and its rules about which stops appear.
 * - Ask-tier calls prompt Yes / Yes-for-session / No; non-interactive modes
 *   deny with an instructive reason instead of prompting.
 * - Auto mode replaces the prompt with an approval classifier (see
 *   `extensions/auto-mode`). This file owns the gate; that directory owns the
 *   rules, the shell pre-gate, and the classifier call. Protected-path writes
 *   are checked here before allow rules, so no allow rule can pre-approve a
 *   write to `.git/hooks` or `.claude`.
 */

import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ChildAction,
	renderActions,
	SUBAGENT_ACTIONS_CHANNEL,
	type SubagentActionsPayload,
} from "../auto-mode/actions.ts";
import { classify, createClassifierState } from "../auto-mode/classifier.ts";
import {
	type AutoModeConfig,
	autoModeSettingsPaths,
	loadAutoModeConfig,
	loadAutoModeConfigWithDiagnostics,
	persistClassifierModel,
} from "../auto-mode/config.ts";
import { modelPickerComponent, type PickerEntry, pickerSpec, toPickerEntries } from "../auto-mode/model-picker.ts";
import { DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, DEFAULT_SOFT_DENY } from "../auto-mode/defaults.ts";
import { appendDecision, type DecisionEntry, decisionEntry } from "../auto-mode/decision-log.ts";
import { loadProjectInstructions } from "../auto-mode/instructions.ts";
import { classifierCandidates, describeCandidate, findConfigured } from "../auto-mode/model-select.ts";
import { resolveForContainment, toAbsolute } from "../auto-mode/paths.ts";
import { PauseTracker } from "../auto-mode/pause.ts";
import { safetyControlWrite } from "../auto-mode/safety-floor.ts";
import { analyzeShellCommand, type ShellEvidence } from "../auto-mode/shell-analysis.ts";
import { findGitRoot } from "../lib/git.ts";
import { memoryDir } from "../lib/memory.ts";
import { sessionScratchpadDir } from "../lib/scratchpad.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import {
	decide,
	extractSubject,
	normalizeToolName,
	parseRule,
	parseRules,
	type PermissionMode,
	type PermissionRule,
} from "./matcher.ts";
import { MODE_BADGES, modeBadge, nextMode, PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "./modes.ts";
import { isWritingTool } from "./protected-paths.ts";
import { loadPermissionSettings, normalizePermissionMode, persistAllowRule, settingsPaths } from "./settings.ts";

const DENIED_BY_USER =
	"The user doesn't want to proceed with this tool use. The tool use was rejected. Adjust your approach based on the user's feedback instead of retrying the same call.";
const DENIED_NON_INTERACTIVE =
	"Permission required but this session is non-interactive, so the user cannot approve the call. It was blocked. Only pre-approved tools can run here; work within those, or ask the user to re-run interactively or with an allow rule / --dangerously-skip-permissions.";
const DENIED_PLAN_MODE =
	"You are in plan mode: only read-only tools may run. Do not attempt mutations; present your plan to the user instead.";
const DENIED_DONT_ASK =
	"Permission mode is dontAsk: anything that would normally prompt the user is denied instead. Only pre-approved tools can run; work within those, or tell the user which allow rule would unblock you.";
const DENIED_PROTECTED_PATH =
	"That path is protected: it configures the user's tooling or this agent itself, so writes to it are never auto-approved and allow rules do not cover them. Achieve the goal another way, or ask the user to make the change.";
const DENIED_BY_CLASSIFIER = (reason: string) =>
	`Blocked by the auto-mode approval classifier: ${reason}\n\nDo not retry the same call and do not try to work around the block. If you believe the action is what the user asked for, say so and let them decide.`;
const DENIED_SAFETY_FLOOR = (reason: string) =>
	`Auto mode blocked this call without consulting the classifier: ${reason}. Writes to the gate's own configuration are never auto-approved. Do not retry or route around this; ask the user to make the change themselves.`;
/**
 * Why a delegation call reaches the classifier. Auto mode judges the task before
 * the child starts, so the thing to weigh is the instruction being handed over,
 * not the tool call's mechanics.
 */
const DELEGATION_ROUTE_REASONS: Record<string, string | undefined> = {
	subagent:
		"This spawns a subagent: a fresh agent loop that will act on the task text below with the same permissions as this session. Judge the delegated task itself — whether carrying it out would require anything the rules forbid — because the child will not refuse a task its parent should not have handed it.",
	workflow:
		"This launches a multi-agent workflow whose script fans work out to subagents. Judge what the script sets out to do, since its agents inherit this session's permissions.",
};
/**
 * The default: nothing more specific than "no rule pre-approved this". Stated
 * explicitly rather than left blank, because a classifier told nothing about why
 * it is being asked will supply its own answer.
 */
const RESIDUAL_ROUTE_REASON =
	"No permission rule covered this call and it is not a read or a working-directory edit, which is why it reaches you. There is nothing unusual about it beyond that — judge it on the rules and the user's request.";
const DENIED_BY_RULE = (rule: string) =>
	`This tool call is denied by the permission rule "${rule}" in the user's settings. Do not retry it; choose a different approach.`;

export default function permissionsExtension(pi: ExtensionAPI) {
	pi.registerFlag("permission-mode", {
		description:
			"Permission mode: default (alias: manual) | acceptEdits | plan | auto | bypassPermissions | dontAsk",
		type: "string",
	});
	pi.registerFlag("dangerously-skip-permissions", {
		description: "Skip all permission prompts (Claude Code compatible)",
		type: "boolean",
	});

	/**
	 * Subagent children (pi subprocesses spawned by pi-subagents) inherit the
	 * parent session's permission mode, Claude Code-style: the parent exports
	 * it via env, the child's copy of this extension reads it back.
	 */
	const MODE_ENV = "CC_PERMISSION_MODE";
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";

	let mode: PermissionMode = "default";
	/** Whether bypassPermissions is a stop on the cycle — only when the session started with it (Claude Code semantics). */
	let bypassInCycle = false;
	/** Whether auto mode is a stop on the cycle — only when a classifier model is reachable. */
	let autoInCycle = false;
	let deny: PermissionRule[] = [];
	let ask: PermissionRule[] = [];
	let allow: PermissionRule[] = [];
	const sessionAllows: PermissionRule[] = [];
	/** Plan mode's one writable file, announced by the plan-mode extension. */
	let planFilePath: string | undefined;
	/**
	 * The session's auto-memory and scratchpad dirs, re-derived rather than
	 * shared with the extensions that own them (jiti isolates module state);
	 * decide() allows writes landing inside them.
	 */
	let memoryDirPath: string | undefined;
	let scratchpadDirPath: string | undefined;

	/**
	 * Mode changes arrive over the event bus too (plan-mode tools), where no ctx
	 * is passed, so the badge is painted through the last ctx seen. session_start
	 * refreshes it, which also covers reloads replacing the session.
	 */
	let badgeCtx: ExtensionContext | undefined;

	/**
	 * The classifier the banner and badge should name: the pinned one once a
	 * call has settled it, otherwise the chain's first candidate — the thing
	 * that *will* screen the next call, worth showing before it happens.
	 */
	const classifierForDisplay = (): { classifier?: string; pinned: boolean } => {
		if (classifierState.pinned) {
			return { classifier: `${classifierState.pinned.provider}/${classifierState.pinned.id}`, pinned: true };
		}
		if (!badgeCtx) return { pinned: false };
		autoConfig ??= loadAutoModeConfig(os.homedir());
		const chain = classifierCandidates({
			available: badgeCtx.modelRegistry.getAvailable(),
			sessionModel: badgeCtx.model,
			configured: autoConfig.classifierModel,
		}).filter((entry) => !classifierState.rejected.has(`${entry.model.provider}/${entry.model.id}`));
		const first = chain[0];
		return { classifier: first ? `${first.model.provider}/${first.model.id}` : undefined, pinned: false };
	};

	const applyBadge = () => {
		// setStatus is a no-op outside the TUI, so this is safe unconditionally.
		badgeCtx?.ui.setStatus(
			"permission-mode",
			modeBadge(mode, {
				paused: pauseTracker.isPaused(),
				classifierModel: classifierState.pinned?.id,
			}),
		);
		// The banner shows mode and classifier live; it listens on the bus
		// because jiti isolates module state between extensions.
		const display = mode === "auto" ? classifierForDisplay() : { pinned: false };
		pi.events.emit(PERMISSION_STATUS_CHANNEL, {
			mode,
			paused: pauseTracker.isPaused(),
			classifier: display.classifier,
			pinned: display.pinned,
		} satisfies PermissionStatus);
	};

	/** Auto-mode state. Loaded lazily: most sessions never enter auto mode. */
	let autoConfig: AutoModeConfig | undefined;
	let projectInstructions: string | undefined;
	let instructionsLoaded = false;
	const pauseTracker = new PauseTracker();
	/**
	 * Which model the classifier settled on. Held here so the choice is pinned for
	 * the session rather than re-resolved per call, and so a model that turns out
	 * to be unusable is not retried on every tool call.
	 */
	const classifierState = createClassifierState();

	/**
	 * One JSONL line per gate decision when `autoMode.logDecisions` is set. The
	 * permissive direction is the reason this exists: allows are invisible in
	 * the UI by design, so the log is the only complete record of them.
	 */
	const logDecision = (ctx: ExtensionContext, entry: Omit<DecisionEntry, "ts">) => {
		if (!autoConfig?.logDecisions) return;
		try {
			const file = join(ctx.sessionManager.getSessionDir(), "auto-mode-decisions.jsonl");
			appendDecision(file, decisionEntry({ sessionId: ctx.sessionManager.getSessionId?.(), ...entry }));
		} catch {
			// Logging must never break the gate.
		}
	};

	/** What would be tried, in order, before anything has been pinned. */
	const describeChain = (ctx: ExtensionContext): string => {
		const chain = classifierCandidates({
			available: ctx.modelRegistry.getAvailable(),
			sessionModel: ctx.model,
			configured: autoConfig?.classifierModel,
		});
		return chain.length > 0 ? chain.map(describeCandidate).join(" → ") : "(no model available)";
	};

	/**
	 * The user's own messages, and only those — the classifier's "explicit intent"
	 * tier must not be reachable from file contents or command output, or a
	 * prompt injection could manufacture its own authorisation. pi's `input`
	 * event fires for real user input, which is exactly that boundary.
	 */
	const userMessages: string[] = [];
	pi.on("input", (event) => {
		const text = event.text?.trim();
		if (!text) return;
		userMessages.push(text);
		if (userMessages.length > 12) userMessages.shift();
	});

	/**
	 * Run the deterministic pre-gate, then the classifier. The pre-gate may only
	 * ever conclude "safe" (see auto-mode/shell-analysis.ts); when it does, the
	 * classifier call is skipped entirely, which is what keeps read-heavy work
	 * from paying classifier latency on every call.
	 */
	const runClassifier = async (
		toolName: string,
		input: Record<string, unknown>,
		subject: string,
		ctx: ExtensionContext,
		routedBecause: string,
	) => {
		autoConfig ??= loadAutoModeConfig(os.homedir());
		if (!instructionsLoaded) {
			projectInstructions = loadProjectInstructions(ctx.cwd, os.homedir());
			instructionsLoaded = true;
		}

		let evidence: ShellEvidence | undefined;
		if (normalizeToolName(toolName) === "bash" && subject) {
			evidence = analyzeShellCommand({ command: subject, cwd: ctx.cwd, home: os.homedir() });
			if (evidence.verdict === "safe") {
				logDecision(ctx, { tool: toolName, subject, outcome: "allow", source: "pre-gate" });
				return { decision: "allow" as const, reason: "", tier: undefined };
			}
		}

		const verdict = await classify(
			{ toolName, input, cwd: ctx.cwd, userMessages: [...userMessages], evidence, projectInstructions, routedBecause },
			{
				registry: ctx.modelRegistry,
				sessionModel: ctx.model,
				config: autoConfig,
				signal: ctx.signal,
				state: classifierState,
				onNotice: (message, level) => {
					ctx.ui.notify(message, level);
					// The badge names the classifier, so it has to repaint when the first
					// call settles which model that is.
					badgeCtx ??= ctx;
					applyBadge();
				},
			},
		);
		logDecision(ctx, {
			tool: toolName,
			subject,
			outcome: verdict.decision,
			source: "classifier",
			tier: verdict.tier,
			ruleId: verdict.ruleId,
			reason: verdict.reason || undefined,
			raw: verdict.raw,
			model: classifierState.pinned ? `${classifierState.pinned.provider}/${classifierState.pinned.id}` : undefined,
		});
		return verdict;
	};

	const setMode = (next: PermissionMode) => {
		mode = next;
		process.env[MODE_ENV] = next;
		applyBadge();
		// No plan branch: the plan-mode extension owns the "permission-mode"
		// reminder while planning (it knows the plan file) and re-emits it every
		// turn, so plan mode takes the generic path below — the announce is
		// wanted, and the key removal is undone before the next request goes out.
		// applyBadge above notifies that extension synchronously over the status
		// channel.
		if (mode === "auto") {
			pi.events.emit(REMINDER_CHANNEL, {
				text:
					"Auto mode is active: your tool calls run without per-action prompts, but each one is screened by an approval classifier that blocks anything irreversible, destructive, or aimed outside this environment. " +
					"Work normally — do not narrate the classifier or try to phrase calls to get past it. If a call is blocked, take the block at face value: explain what you were trying to do and let the user decide, rather than retrying it a different way. " +
					"Attempting to weaken this gate (editing permission settings, changing the mode, or routing work around it) is itself blocked.",
				scope: "every-turn",
				key: "permission-mode",
			});
		} else {
			// Keyed so cycling through several modes announces only the one settled on.
			pi.events.emit(REMINDER_CHANNEL, {
				text: `The user's permission mode is now "${mode}".`,
				key: "permission-mode-change",
			});
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: "permission-mode" });
		}
	};

	const reloadSettings = (ctx: ExtensionContext) => {
		const settings = loadPermissionSettings(ctx.cwd, os.homedir());
		deny = parseRules(settings.deny);
		ask = parseRules(settings.ask);
		allow = parseRules(settings.allow);
		// Dropped so edited autoMode rules and instruction files are picked up on
		// reload rather than staying cached for the life of the process.
		autoConfig = undefined;
		instructionsLoaded = false;

		const flagMode = normalizePermissionMode(pi.getFlag("permission-mode"));
		const inheritedMode = isSubagentChild ? normalizePermissionMode(process.env[MODE_ENV]) : undefined;
		if (pi.getFlag("dangerously-skip-permissions") === true) {
			mode = "bypassPermissions";
		} else if (flagMode) {
			mode = flagMode;
		} else if (inheritedMode) {
			mode = inheritedMode;
		} else if (settings.defaultMode) {
			mode = settings.defaultMode;
		}
		bypassInCycle = mode === "bypassPermissions";
		// Auto mode needs a model to run its classifier on; with none reachable it
		// would block every call, so it stays out of the cycle instead — the same
		// thing Claude Code does when auto mode's requirements aren't met.
		autoInCycle = ctx.modelRegistry.getAvailable().length > 0;
		if (mode === "plan") setMode("plan");
		process.env[MODE_ENV] = mode;
	};

	pi.on("session_start", (_event, ctx) => {
		badgeCtx = ctx;
		memoryDirPath = memoryDir(os.homedir(), findGitRoot(ctx.cwd) ?? ctx.cwd);
		scratchpadDirPath = sessionScratchpadDir(ctx.cwd, ctx.sessionManager.getSessionId());
		reloadSettings(ctx);
		applyBadge();
	});

	// Mode-change requests from other extensions (e.g. plan-mode tools).
	pi.events.on("one-code:set-permission-mode", (data) => {
		const requested = normalizePermissionMode((data as { mode?: unknown })?.mode);
		if (requested) setMode(requested);
	});

	// The plan-mode extension announces the plan file (see PLAN_FILE_CHANNEL
	// there); decide() then allows writes to that one path in plan mode.
	pi.events.on("one-code:plan-file-path", (data) => {
		const path = (data as { path?: unknown })?.path;
		if (typeof path === "string" && path) planFilePath = path;
	});

	// Claude Code cycles permission modes with shift+tab; pi reserves that key
	// for the thinking dial. ctrl+q is the one ctrl+letter pi leaves unbound
	// that terminals don't already own (ctrl+m *is* Enter's byte, alt needs
	// option-as-meta configured on macOS) — see docs/decisions.md.
	pi.registerShortcut("ctrl+q", {
		description: "Cycle permission mode",
		handler: (ctx) => {
			badgeCtx = ctx;
			setMode(nextMode(mode, { bypassInCycle, autoInCycle }));
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const normalizedTool = normalizeToolName(event.toolName);
		const subject = extractSubject(normalizedTool, event.input as Record<string, unknown>);
		// Resolved through symlinks so the protected-path check sees where a
		// write actually lands, not how the path is spelled. Only for writing
		// tools: a bash subject is a command line, not a path.
		const resolvedSubject =
			isWritingTool(normalizedTool) && subject
				? resolveForContainment(toAbsolute(ctx.cwd, subject, os.homedir()))
				: undefined;
		const result = decide({
			toolName: event.toolName,
			subject,
			cwd: ctx.cwd,
			mode,
			deny,
			ask,
			allow: [...allow, ...sessionAllows],
			classifyAllShell: autoConfig?.classifyAllShell,
			resolvedSubject,
			planFilePath,
			memoryDirPath,
			scratchpadDirPath,
		});

		/**
		 * Auto mode's deterministic floor: a write to the files the gate is made
		 * of (permission settings, autoMode config) is never auto-approved — not
		 * by an allow rule, not by the classifier, whose hard-deny rules are only
		 * as strong as the model enforcing them. Interactive sessions always
		 * prompt; non-interactive runs block. Runs even when a rule would allow,
		 * because a session allow rule ("write", approved once) must not cover
		 * the write that disables every check after it.
		 */
		const floorReason =
			mode === "auto"
				? safetyControlWrite({
						toolName: normalizeToolName(event.toolName),
						input: event.input as Record<string, unknown>,
						cwd: ctx.cwd,
						home: os.homedir(),
					})
				: undefined;

		if (result.decision === "allow" && !floorReason) return undefined;

		if (result.decision === "deny") {
			if (result.cause === "plan-mode") return { block: true, reason: DENIED_PLAN_MODE };
			if (result.cause === "protected-path") return { block: true, reason: DENIED_PROTECTED_PATH };
			// The only mode that denies (rather than allows) unmatched calls is dontAsk.
			if (result.cause === "mode") return { block: true, reason: DENIED_DONT_ASK };
			return { block: true, reason: DENIED_BY_RULE(result.rule?.raw ?? "deny") };
		}

		let classifierBlock: string | undefined;
		if (floorReason) {
			// Never reaches the classifier: fall through to the prompt below, or
			// block outright where there is no one to ask.
			autoConfig ??= loadAutoModeConfig(os.homedir());
			if (!ctx.hasUI) {
				logDecision(ctx, { tool: event.toolName, subject, outcome: "block", source: "floor", reason: floorReason });
				return { block: true, reason: DENIED_SAFETY_FLOOR(floorReason) };
			}
			logDecision(ctx, { tool: event.toolName, subject, outcome: "prompt", source: "floor", reason: floorReason });
		} else if (result.decision === "classify") {
			// Auto mode pauses after repeated blocks and prompts instead, so a model
			// looping against the classifier reaches the user rather than grinding.
			if (!pauseTracker.isPaused()) {
				const routedBecause =
					result.cause === "protected-path"
						? `This call writes ${subject}, which is a protected path: it configures the user's tooling or this agent itself (git hooks and config, editor and container settings, shell rc files, package-manager config, this agent's own permission settings). It is inside the working directory — that is not what makes it risky. Writes here take effect later without any further approval, and permission allow rules deliberately do not cover them, which is why you are being asked rather than the rules deciding. Judge whether the user asked for this specific change.`
						: (DELEGATION_ROUTE_REASONS[normalizeToolName(event.toolName)] ?? RESIDUAL_ROUTE_REASON);
				const outcome = await runClassifier(
					event.toolName,
					event.input as Record<string, unknown>,
					subject,
					ctx,
					routedBecause,
				);
				if (outcome.decision === "allow") {
					pauseTracker.recordAllow();
					return undefined;
				}

				const tripped = pauseTracker.recordBlock({
					toolName: event.toolName,
					subject,
					reason: outcome.reason,
					tier: outcome.tier,
					ruleId: outcome.ruleId,
					raw: outcome.raw,
				});
				if (tripped) {
					const { lifetime } = pauseTracker.stats();
					ctx.ui.notify(
						`Auto mode paused after ${lifetime} blocked call${lifetime === 1 ? "" : "s"} — approving a prompt resumes it.`,
						"warning",
					);
					applyBadge();
				}
				// A hard-deny verdict is not the user's to override: prompting would
				// hand back exactly what the tier exists to refuse.
				if (outcome.tier === "hard_deny") {
					return { block: true, reason: DENIED_BY_CLASSIFIER(outcome.reason) };
				}
				// Non-interactively there is no one to ask, so the classifier's own
				// reason is more useful to the model than a generic refusal.
				if (!ctx.hasUI) return { block: true, reason: DENIED_BY_CLASSIFIER(outcome.reason) };
				classifierBlock = outcome.reason;
			}
			// Paused, or a soft block worth asking about: fall through and prompt.
		}

		// ask
		if (!ctx.hasUI) {
			return { block: true, reason: DENIED_NON_INTERACTIVE };
		}

		const preview = subject.length > 200 ? `${subject.slice(0, 200)}…` : subject;
		const title = floorReason
			? `Auto mode never auto-approves this — ${event.toolName} ${floorReason}.\n\n  ${preview}\n\n  Allow it this once?`
			: classifierBlock
				? `Auto mode blocked this — allow it anyway?\n\n  ${preview || "(no arguments)"}\n\n  Classifier: ${classifierBlock}`
				: result.cause === "protected-path"
				? `Allow ${event.toolName} to write a protected path?\n\n  ${preview}\n\n  This path configures your tooling or this agent, so allow rules do not pre-approve it.`
				: `Allow ${event.toolName}?\n\n  ${preview || "(no arguments)"}`;
		const YES = "Yes";
		const YES_SESSION = "Yes, don't ask again this session";
		const NO = "No, tell the agent what to do differently";
		const choice = await ctx.ui.select(title, [YES, YES_SESSION, NO]);

		// The user's answer is itself a gate decision worth recording — it is the
		// ground truth a drifting classifier gets calibrated against.
		if (mode === "auto" && (floorReason || classifierBlock)) {
			logDecision(ctx, {
				tool: event.toolName,
				subject,
				outcome: choice === YES || choice === YES_SESSION ? "allow" : "block",
				source: "user",
				reason: floorReason ?? classifierBlock,
			});
		}

		// Approving a prompted call is what resumes a paused auto mode.
		if (choice === YES || choice === YES_SESSION) {
			if (mode === "auto") {
				const wasPaused = pauseTracker.isPaused();
				pauseTracker.resume();
				if (wasPaused) applyBadge();
			}
		}

		if (choice === YES) return undefined;
		if (choice === YES_SESSION) {
			const tool = normalizeToolName(event.toolName);
			const rule = tool === "bash" && subject ? parseRule(`bash(${subject})`) : parseRule(tool);
			if (rule) sessionAllows.push(rule);
			return undefined;
		}

		// The "tell the agent what to do differently" option has to actually carry
		// the user's words, or the model is left guessing why it was stopped.
		const feedback = await ctx.ui.input("What should the agent do instead?", "Optional — press Esc to skip");
		return {
			block: true,
			reason: feedback?.trim() ? `${DENIED_BY_USER}\n\nThe user said: ${feedback.trim()}` : DENIED_BY_USER,
		};
	});

	pi.registerCommand("permissions", {
		description: "Show permission mode and loaded rules",
		handler: async (_args, ctx) => {
			const fmt = (rules: PermissionRule[]) => (rules.length ? rules.map((r) => r.raw).join(", ") : "(none)");
			const denials = pauseTracker.recentDenials();
			const autoLines =
				mode === "auto" || denials.length > 0
					? [
							`auto mode: ${pauseTracker.isPaused() ? "paused (approve a prompt to resume)" : "active"}, ${
								pauseTracker.stats().lifetime
							} blocked this session`,
							...(denials.length > 0
								? [
										"recently denied:",
										...denials.map((d) => `  ${d.toolName}(${d.subject.slice(0, 60)}) — ${d.reason}`),
									]
								: []),
						]
					: [];
			ctx.ui.notify(
				[
					`mode: ${mode}`,
					`deny: ${fmt(deny)}`,
					`ask: ${fmt(ask)}`,
					`allow: ${fmt(allow)}`,
					`session allows: ${fmt(sessionAllows)}`,
					...autoLines,
				].join("\n"),
				"info",
			);
		},
	});

	/**
	 * Auto mode's third subagent checkpoint: when a child returns, review what it
	 * actually did. The spawn was classified and each of the child's own actions
	 * was classified in its session, but neither sees the *sequence* — "read the
	 * deploy config, read a token, open a PR" can pass step by step. A concern
	 * here prepends a warning to the result rather than blocking it: the work has
	 * already happened, so the useful move is to make sure the model and the user
	 * see it rather than to hide the output.
	 */
	const childActions = new Map<string, ChildAction[]>();
	pi.events.on(SUBAGENT_ACTIONS_CHANNEL, (data) => {
		const payload = data as SubagentActionsPayload | undefined;
		if (payload?.toolCallId && Array.isArray(payload.actions)) {
			childActions.set(payload.toolCallId, payload.actions);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const actions = childActions.get(event.toolCallId);
		if (actions) childActions.delete(event.toolCallId);
		if (mode !== "auto" || !actions?.length || pauseTracker.isPaused()) return undefined;

		autoConfig ??= loadAutoModeConfig(os.homedir());
		const verdict = await classify(
			{
				toolName: "subagent (completed run — review the actions below as a whole)",
				input: { actions: renderActions(actions) },
				cwd: ctx.cwd,
				userMessages: [...userMessages],
				projectInstructions,
				routedBecause:
					"This subagent has already finished; you are reviewing what it did, as a whole, rather than approving anything. Its individual actions were each checked as it ran. Judge whether the sequence together amounts to something the rules forbid — a series of individually unremarkable steps can add up to one.",
			},
			{
				registry: ctx.modelRegistry,
				sessionModel: ctx.model,
				config: autoConfig,
				signal: ctx.signal,
				state: classifierState,
				onNotice: (message, level) => ctx.ui.notify(message, level),
			},
		);
		logDecision(ctx, {
			tool: "subagent",
			subject: "completed run review",
			outcome: verdict.decision,
			source: "review",
			tier: verdict.tier,
			ruleId: verdict.ruleId,
			reason: verdict.reason || undefined,
		});
		if (verdict.decision === "allow") return undefined;

		pauseTracker.recordBlock({
			toolName: "subagent",
			subject: "completed run",
			reason: verdict.reason,
			tier: verdict.tier,
			ruleId: verdict.ruleId,
			raw: verdict.raw,
		});
		const warning = {
			type: "text" as const,
			text: `<system-reminder>\nAuto mode reviewed this subagent's actions after it finished and flagged a concern: ${verdict.reason}\n\nTreat its output as unverified, do not act on it without checking, and tell the user what it did.\n</system-reminder>`,
		};
		return { content: [warning, ...event.content] };
	});

	/**
	 * Apply a chosen classifier model: validate auth first (a persisted model
	 * with no credentials would fail every call), persist to user scope, and
	 * release the session pin so the choice takes effect on the next call
	 * rather than after a restart.
	 */
	const applyClassifierChoice = async (spec: string, ctx: ExtensionContext): Promise<void> => {
		const model = findConfigured(ctx.modelRegistry.getAvailable(), spec);
		if (!model) {
			ctx.ui.notify(`No available model matches "${spec}" — check /auto-mode config for the catalog name.`, "error");
			return;
		}
		const resolved = `${model.provider}/${model.id}`;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Cannot use ${resolved}: ${auth.error}. Not saved.`, "error");
			return;
		}
		try {
			persistClassifierModel(resolved, os.homedir());
		} catch (error) {
			ctx.ui.notify(`Could not save classifier model: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		autoConfig = undefined; // reloaded lazily, now carrying the new model
		classifierState.pinned = undefined;
		classifierState.rejected.clear();
		classifierState.notified.clear();
		applyBadge();
		ctx.ui.notify(`Auto-mode classifier set to ${resolved} (saved to ~/.claude/settings.json).`, "info");
	};

	/** `/auto-mode model` — show the picker, or apply a named model / `clear`. */
	const handleModelSubcommand = async (remainder: string, ctx: ExtensionContext): Promise<void> => {
		if (remainder === "clear") {
			try {
				persistClassifierModel(undefined, os.homedir());
			} catch (error) {
				ctx.ui.notify(`Could not update settings: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			autoConfig = undefined;
			classifierState.pinned = undefined;
			classifierState.rejected.clear();
			classifierState.notified.clear();
			applyBadge();
			ctx.ui.notify(`autoMode.classifierModel cleared. Auto mode will choose: ${describeChain(ctx)}`, "info");
			return;
		}
		if (remainder) {
			await applyClassifierChoice(remainder, ctx);
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		if (available.length === 0) {
			ctx.ui.notify("No models are available — authenticate a provider first.", "warning");
			return;
		}
		// The picker needs focus and a terminal; elsewhere say what to type.
		if (!ctx.hasUI || ctx.mode !== "tui") {
			autoConfig ??= loadAutoModeConfig(os.homedir());
			ctx.ui.notify(
				`classifierModel: ${autoConfig.classifierModel ?? "(not set)"}. Set one with /auto-mode model <provider/model-id>, or clear it with /auto-mode model clear.`,
				"info",
			);
			return;
		}

		autoConfig ??= loadAutoModeConfig(os.homedir());
		const current = autoConfig.classifierModel;
		const entries = toPickerEntries(available);

		const chosen = await ctx.ui.custom<PickerEntry | null>((tui, theme, _keybindings, done) =>
			modelPickerComponent({ entries, current }, tui, theme, done),
		);

		if (chosen) await applyClassifierChoice(pickerSpec(chosen), ctx);
	};

	pi.registerCommand("auto-mode", {
		description: "Auto-mode classifier: /auto-mode [defaults|config|model [provider/model-id|clear]]",
		getArgumentCompletions: () =>
			[
				{ value: "config", label: "effective rules" },
				{ value: "defaults", label: "built-in rules" },
				{ value: "model", label: "choose the classifier model" },
			],
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "model") {
				await handleModelSubcommand(rest.join(" ").trim(), ctx);
				return;
			}
			const which = sub ?? "config";
			if (which !== "defaults" && which !== "config") {
				ctx.ui.notify(
					`Unknown subcommand "${which}". Use: /auto-mode defaults | config | model [provider/model-id|clear]`,
					"warning",
				);
				return;
			}
			// "defaults" prints the built-in lists; "config" prints what the
			// classifier actually uses, with $defaults already spliced in. The
			// config view re-reads disk so it shows the file as it is now, and
			// refreshes the gate's cached copy while it is at it.
			const loaded = which === "config" ? loadAutoModeConfigWithDiagnostics(os.homedir()) : undefined;
			if (loaded) autoConfig = loaded.config;
			const shown = loaded
				? loaded.config
				: {
						environment: DEFAULT_ENVIRONMENT,
						allow: DEFAULT_ALLOW,
						soft_deny: DEFAULT_SOFT_DENY,
						hard_deny: DEFAULT_HARD_DENY,
					};
			const section = (title: string, entries: string[]) =>
				`${title} (${entries.length}):\n${entries.map((entry) => `  - ${entry}`).join("\n")}`;
			ctx.ui.notify(
				[
					which === "config"
						? `read from: ${autoModeSettingsPaths(os.homedir()).join(", ")}\n(project settings are deliberately not read — a repo could otherwise grant itself allow rules)`
						: "built-in rules; add \"$defaults\" to a list in settings to keep them",
					section("hard_deny", shown.hard_deny),
					section("soft_deny", shown.soft_deny),
					section("allow", shown.allow),
					section("environment", shown.environment),
					...(which === "config" && "classifyAllShell" in shown
						? [
								`classifyAllShell: ${shown.classifyAllShell}`,
								`logDecisions: ${shown.logDecisions} (auto-mode-decisions.jsonl next to the session files)`,
								`classifierModel: ${shown.classifierModel ?? "(not set — /auto-mode model chooses one)"}`,
								// Which model actually screens calls, and why — this reads the
								// user's prompts, so it should not take knowing the code to find out.
								`classifier in use: ${
									classifierState.pinned
										? `${classifierState.pinned.provider}/${classifierState.pinned.id} (pinned for this session)`
										: describeChain(ctx)
								}`,
								...(classifierState.rejected.size > 0
									? [`unusable this session: ${[...classifierState.rejected].join(", ")}`]
									: []),
							]
						: []),
					...(loaded && loaded.diagnostics.length > 0
						? [`settings problems:\n${loaded.diagnostics.map((line) => `  ! ${line}`).join("\n")}`]
						: []),
				].join("\n\n"),
				loaded && loaded.diagnostics.length > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("allow", {
		description: 'Persist an allow rule: /allow Bash(npm test:*) [global]',
		handler: async (args, ctx) => {
			const global = /\s+global$/.test(args.trim());
			const raw = args.trim().replace(/\s+global$/, "");
			const rule = parseRule(raw);
			if (!rule) {
				ctx.ui.notify(`Could not parse rule: "${raw}". Format: Tool or Tool(pattern)`, "warning");
				return;
			}
			const paths = settingsPaths(ctx.cwd, os.homedir());
			const target = global ? paths.user : paths.local;
			persistAllowRule(raw, target);
			allow.push(rule);
			ctx.ui.notify(`Added allow rule ${raw} to ${target}`, "info");
		},
	});
}
