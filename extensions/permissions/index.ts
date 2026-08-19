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
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChildAction, SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../auto-mode/actions.ts";
import { classify, createClassifierState } from "../auto-mode/classifier.ts";
import {
	type AutoModeConfig,
	autoModeSettingsPaths,
	loadAutoModeConfig,
	loadAutoModeConfigWithDiagnostics,
	persistAutoModeSetup,
	persistClassifierModel,
	removeUserPermissionAllow,
} from "../auto-mode/config.ts";
import { auditPermissionAllow, renderProposal, settingsPatch } from "../auto-mode/setup.ts";
import { draftSetup, gatherFacts } from "../auto-mode/setup-run.ts";
import { modelPickerComponent, type PickerEntry, pickerSpec, toPickerEntries } from "../auto-mode/model-picker.ts";
import { DEFAULT_ENVIRONMENT } from "../auto-mode/defaults.ts";
import type { TranscriptEntry } from "../auto-mode/transcript.ts";
import { appendDecision, type DecisionEntry, decisionEntry } from "../auto-mode/decision-log.ts";
import { loadProjectInstructions } from "../auto-mode/instructions.ts";
import { classifierCandidates, describeCandidate, findConfigured } from "../auto-mode/model-select.ts";
import { modelIdentity } from "../lib/model-policy.ts";
import { isWithin, resolveForContainment, toAbsolute } from "../auto-mode/paths.ts";
import { PauseTracker } from "../auto-mode/pause.ts";
import { checkRecoverability } from "../auto-mode/recoverability.ts";
import { safetyControlWrite } from "../auto-mode/safety-floor.ts";
import { isExecutionPrimitivePath, isSensitivePath } from "../auto-mode/sensitive.ts";
import { analyzeShellCommand, type ShellEvidence } from "../auto-mode/shell-analysis.ts";
import { projectMemoryDir } from "../lib/memory.ts";
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
import { modeBadge, nextMode, PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "./modes.ts";
import { type ChildToolCall, type ChildGateDecision, SUBAGENT_GATE_CHANNEL } from "./subagent-gate.ts";
import { ORIGINAL_COMMAND_KEY } from "../worktree/rewrite.ts";
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
// Returned to the MODEL, not the user: auto mode exists to run unattended, so a
// block is handed back so the model can accomplish the goal a safe way — mirrors
// Claude Code's own auto-mode denial message rather than halting for a prompt.
const DENIED_BY_CLASSIFIER = (reason: string) =>
	`Permission for this action was denied by the auto-mode approval classifier. Reason: ${reason}\n\n` +
	"If you have other tasks that don't depend on this action, continue with those. You *may* try to accomplish the goal a different, safe way (e.g. a less destructive command, or committing first so a change is recoverable), but do *not* try to work around or defeat this denial. If you believe this capability is essential, STOP and explain to the user what you were trying to do and why, and let them decide.";
const BLOCKED_BY_TIMEOUT = (reason: string) =>
	`${reason}\n\nThis was not a judgement that the call is unsafe. Wait a moment and try this action again. ` +
	"If it keeps failing, continue with other tasks that do not require this action and come back to it later — " +
	"reading files, searching code, and other read-only operations do not require the classifier and can still be used. " +
	"Do not try to route around the gate; if this specific action is essential, tell the user what you were about to do so they can re-run interactively or pin a faster classifier with /auto-mode model.";
const DENIED_SAFETY_FLOOR = (reason: string) =>
	`Auto mode blocked this call without consulting the classifier: ${reason}. Writes to the gate's own configuration are never auto-approved. Do not retry or route around this; ask the user to make the change themselves.`;
const DENIED_BY_RULE = (rule: string) =>
	`This tool call is denied by the permission rule "${rule}" in the user's settings. Do not retry it; choose a different approach.`;

/** Truncate a subject for a permission prompt — shared by the main gate and the subagent bridge. */
const previewSubject = (subject: string) => (subject.length > 200 ? `${subject.slice(0, 200)}…` : subject);

/** Map a `decide()` deny result to its model-facing reason — shared by both gate paths. */
const denyReason = (result: { cause?: string; rule?: { raw?: string } }): string =>
	result.cause === "plan-mode"
		? DENIED_PLAN_MODE
		: result.cause === "protected-path"
			? DENIED_PROTECTED_PATH
			: result.cause === "mode"
				? DENIED_DONT_ASK
				: DENIED_BY_RULE(result.rule?.raw ?? "deny");

/** Ask-prompt option labels — shared by both gate paths. */
const YES = "Yes";
const YES_SESSION = "Yes, don't ask again this session";
const NO = "No, tell the agent what to do differently";

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

	/** True while the model is streaming — the badge carries the interrupt hint. */
	let streaming = false;

	/**
	 * The classifier the banner and badge should name: the pinned one once a
	 * call has settled it, otherwise the chain's first candidate — the thing
	 * that *will* screen the next call, worth showing before it happens.
	 */
	const classifierForDisplay = (sessionModel?: Model<Api>): { classifier?: string; pinned: boolean } => {
		if (classifierState.pinned) {
			return { classifier: `${classifierState.pinned.provider}/${classifierState.pinned.id}`, pinned: true };
		}
		if (!badgeCtx) return { pinned: false };
		autoConfig ??= loadAutoModeConfig(os.homedir());
		const chain = classifierCandidates({
			available: badgeCtx.modelRegistry.getAvailable(),
			sessionModel: sessionModel ?? badgeCtx.model,
			configured: autoConfig.classifierModel,
			configuredSetForContainment: autoConfig.classifierModelSetFor,
		}).candidates.filter((entry) => !classifierState.rejected.has(`${entry.model.provider}/${entry.model.id}`));
		const first = chain[0];
		return { classifier: first ? `${first.model.provider}/${first.model.id}` : undefined, pinned: false };
	};

	const applyBadge = (sessionModel?: Model<Api>) => {
		// A below-editor widget, not a footer status: Claude Code renders the
		// mode line directly under the input box, and the workflow status strip
		// sorts itself below this line by re-setting on the status channel
		// (setWidget re-inserts on update, so widget order is last-write order).
		// setWidget is a no-op outside the TUI, so this is safe unconditionally.
		badgeCtx?.ui.setWidget(
			"permission-mode",
			[
				modeBadge(mode, {
					paused: pauseTracker.isPaused(),
					classifierModel: classifierState.pinned?.id,
					streaming,
				}),
			],
			{ placement: "belowEditor" },
		);
		// The banner shows mode and classifier live; it listens on the bus
		// because jiti isolates module state between extensions.
		const display = mode === "auto" ? classifierForDisplay(sessionModel) : { pinned: false };
		pi.events.emit(PERMISSION_STATUS_CHANNEL, {
			mode,
			paused: pauseTracker.isPaused(),
			classifier: display.classifier,
			pinned: display.pinned,
		} satisfies PermissionStatus);
	};

	/** Auto-mode state. Loaded lazily: most sessions never enter auto mode. */
	let autoConfig: AutoModeConfig | undefined;

	// Drop the cached config and classifier selection state, then refresh the badge.
	// Shared by the "set classifier model" and "clear" paths.
	const resetClassifierChoice = (sessionModel?: Model<Api>) => {
		autoConfig = undefined; // reloaded lazily, now carrying any new model
		classifierState.pinned = undefined;
		classifierState.rejected.clear();
		classifierState.notified.clear();
		classifierState.timeoutStreak = 0;
		classifierState.chainCache = undefined;
		applyBadge(sessionModel);
	};
	// Keyed by cwd: a worktree-isolated child classifies against ITS checkout's
	// CLAUDE.md/AGENTS.md, and must not poison the cache the main agent's own
	// calls (a different cwd) read for the rest of the session.
	const projectInstructionsByCwd = new Map<string, string | undefined>();
	const instructionsFor = (cwd: string): string | undefined => {
		if (!projectInstructionsByCwd.has(cwd)) {
			projectInstructionsByCwd.set(cwd, loadProjectInstructions(cwd, os.homedir()));
		}
		return projectInstructionsByCwd.get(cwd);
	};
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
		const { candidates } = classifierCandidates({
			available: ctx.modelRegistry.getAvailable(),
			sessionModel: ctx.model,
			configured: autoConfig?.classifierModel,
			configuredSetForContainment: autoConfig?.classifierModelSetFor,
		});
		return candidates.length > 0 ? candidates.map(describeCandidate).join(" → ") : "(no model available)";
	};

	// Session identity for the classifier's Session Context block (CC system[2]).
	const classifierUsername = (() => {
		try {
			return os.userInfo().username;
		} catch {
			return "user";
		}
	})();

	/**
	 * The classifier's `<transcript>`: user messages and tool inputs, in order,
	 * results stripped (transcript.ts renders it). The last entry is always the
	 * action under review — the tool_call handler appends the call being judged.
	 */
	const transcript: TranscriptEntry[] = [];
	const capTranscript = () => {
		// Bound memory on a long unattended run; the renderer also caps by chars,
		// and intent verification reads userMessages, not this, so trimming old
		// lines here never weakens that check. Trim down to a lower watermark so the
		// O(n) splice is amortized over the next ~100 pushes on the tool_call path.
		if (transcript.length > 500) transcript.splice(0, transcript.length - 400);
	};

	/**
	 * The user's own messages, and only those — the classifier's "explicit intent"
	 * tier must not be reachable from file contents or command output, or a prompt
	 * injection could manufacture its own authorisation. pi's `input` event fires
	 * for real user input, which is exactly that boundary. Carried in FULL (not a
	 * rolling window): in a long unattended run the authorizing setup message must
	 * still clear a later action (decision 2 in docs/decisions/auto-mode.md).
	 */
	const userMessages: string[] = [];
	pi.on("input", (event) => {
		const text = event.text?.trim();
		if (!text) return;
		userMessages.push(text);
		if (userMessages.length > 1000) userMessages.shift();
		transcript.push({ kind: "user", text });
		capTranscript();
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
		/**
		 * Whether the deterministic containment fast-path may clear this call
		 * without the classifier. False for protected paths and for completed-run
		 * subagent reviews — those must always be judged.
		 */
		containmentEligible = false,
		/**
		 * Overrides for a bridged subagent call: its own cwd (a worktree, if
		 * isolated), the child action appended to a COPY of the transcript (the
		 * parent's live transcript is never mutated for a child), and a fresh signal
		 * (the parent's last ctx.signal may be from a settled turn and already
		 * aborted). All default to the parent's own values, so the main path is
		 * unchanged.
		 */
		opts?: { cwd?: string; appendEntry?: TranscriptEntry; signal?: AbortSignal },
	) => {
		const cwd = opts?.cwd ?? ctx.cwd;
		autoConfig ??= loadAutoModeConfig(os.homedir());

		const home = os.homedir();
		const allow = () => ({ decision: "allow" as const, reason: "", tier: undefined });

		let evidence: ShellEvidence | undefined;
		if (normalizeToolName(toolName) === "bash" && subject) {
			evidence = analyzeShellCommand({ command: subject, cwd, home });
			if (evidence.verdict === "safe") {
				logDecision(ctx, { tool: toolName, subject, outcome: "allow", source: "pre-gate" });
				return allow();
			}
			// The command's only risk is an in-project delete or whole-tree reset.
			// Auto mode trusts the project as the agent's sandbox — but, unlike Claude
			// Code, only when git can put the bytes back. A recoverable destruction
			// runs unattended with no classifier call; an unrecoverable one (untracked,
			// dirty, not a repo) still reaches the classifier.
			if (containmentEligible && evidence.containedNonNetwork) {
				const targets = evidence.writes.filter((w) => !w.outsideCwd && w.resolved).map((w) => w.resolved as string);
				// The same cwd the evidence resolved against — for a worktree-isolated
				// child that is the worktree, not the parent checkout (ctx.cwd).
				const rec = checkRecoverability(cwd, { targets, wholeTree: evidence.wholeTree });
				if (rec.verdict === "recoverable") {
					logDecision(ctx, { tool: toolName, subject, outcome: "allow", source: "pre-gate", reason: rec.reason });
					return allow();
				}
				evidence.notes.push(`git recoverability: ${rec.reason}`);
			}
		} else if (containmentEligible && isWritingTool(normalizeToolName(toolName))) {
			// A write/edit whose target is inside the project and not a credential
			// path is ordinary sandbox work — Claude Code auto-approves it, and so do
			// we (protected paths never reach here: decide() routes them with
			// containmentEligible=false). Overwrites are not recoverability-gated the
			// way deletes are: the file still exists, and edit-then-iterate is the
			// core of unattended coding autonomy. Execution-primitive paths (build
			// wrappers, CI workflows, editor auto-run config) are excluded exactly as
			// the bash pre-gate excludes them — being in-project does not make a file
			// that runs later without further approval safe to write unclassified.
			const raw = input.file_path ?? input.path;
			const target = typeof raw === "string" ? raw : undefined;
			if (target) {
				const absolute = toAbsolute(cwd, target, home);
				const resolved = resolveForContainment(absolute);
				const root = resolveForContainment(cwd) ?? cwd;
				if (resolved && isWithin(root, resolved) && !isSensitivePath(absolute) && !isExecutionPrimitivePath(absolute)) {
					logDecision(ctx, { tool: toolName, subject, outcome: "allow", source: "pre-gate" });
					return allow();
				}
			}
		}

		// The current call was pushed onto `transcript` by the tool_call handler, so
		// it is already the last entry — the action under review. `evidence` is used
		// only for the containment fast-path above; CC's payload carries no separate
		// static-analysis block, so it is not sent to the classifier.
		const verdict = await classify(
			{
				toolName,
				transcript: opts?.appendEntry ? [...transcript, opts.appendEntry] : [...transcript],
				userMessages: [...userMessages],
				claudeMd: instructionsFor(cwd),
				username: classifierUsername,
				environment: autoConfig.environment,
				// AutoModeConfig is structurally a RuleExtras (hardDeny/softDeny/allow).
				ruleExtras: autoConfig,
			},
			{
				registry: ctx.modelRegistry,
				sessionModel: ctx.model,
				config: autoConfig,
				signal: opts?.signal ?? ctx.signal,
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
		projectInstructionsByCwd.clear();

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
		lastReviewCtx = ctx;
		memoryDirPath = projectMemoryDir(ctx.cwd);
		scratchpadDirPath = sessionScratchpadDir(ctx.cwd, ctx.sessionManager.getSessionId());
		reloadSettings(ctx);
		applyBadge();
		// Publish the subagent permission bridge (see subagent-gate.ts). The closure
		// reads live parent state on each call, so emitting once at session start is
		// enough; subagents captures it and threads it into child sessions.
		pi.events.emit(SUBAGENT_GATE_CHANNEL, { decide: evaluateChildToolCall });
	});

	pi.on("model_select", (event, ctx) => {
		badgeCtx = ctx;
		lastReviewCtx = ctx;
		autoInCycle = ctx.modelRegistry.getAvailable().length > 0;
		resetClassifierChoice(event.model);
	});

	// The badge carries "· esc to interrupt" only while the model works (CC's
	// mode line does the same).
	pi.on("agent_start", (_event, ctx) => {
		badgeCtx = ctx;
		lastReviewCtx = ctx;
		streaming = true;
		applyBadge();
	});
	pi.on("agent_end", () => {
		streaming = false;
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

	// The most recent turn's context, reused by background subagent reviews (which
	// fire off a channel event and so have no live ctx of their own) and by the
	// subagent permission bridge (a child prompt renders on this parent ctx's UI).
	let lastReviewCtx: ExtensionContext | undefined;

	// Serialize interactive prompts: a background/resident subagent can hit an "ask"
	// while the main turn (or another child) is already awaiting one, and driving
	// ctx.ui.select concurrently on one terminal is unverified. This chains them.
	let promptChain: Promise<unknown> = Promise.resolve();
	const serializePrompt = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = promptChain.then(fn, fn);
		promptChain = run.then(
			() => {},
			() => {},
		);
		return run;
	};

	pi.on("tool_call", async (event, ctx) => {
		lastReviewCtx = ctx;
		const normalizedTool = normalizeToolName(event.toolName);
		const subject = extractSubject(normalizedTool, event.input as Record<string, unknown>);
		// Resolved through symlinks so the protected-path check sees where a
		// write actually lands, not how the path is spelled. Only for writing
		// tools: a bash subject is a command line, not a path.
		const resolvedSubject =
			isWritingTool(normalizedTool) && subject
				? resolveForContainment(toAbsolute(ctx.cwd, subject, os.homedir()))
				: undefined;
		// In a worktree session, worktree's tool_call handler (which runs before this
		// one) cd-wraps bash commands for execution. Rule matching must evaluate the
		// model's original command, not the wrapper — otherwise every configured Bash
		// rule stops matching for the whole session. The classifier and safety floor
		// keep reading event.input (the wrapped command that actually runs).
		const original = (event.input as Record<string, unknown>)[ORIGINAL_COMMAND_KEY];
		const matchSubject = normalizedTool === "bash" && typeof original === "string" ? original : subject;

		// Record every tool call into the classifier transcript (inputs only). In
		// auto mode this is the running <transcript> the classifier reads, and this
		// call is now its last entry — the action under review. For bash, record the
		// model's original command, not the worktree cd-wrapper that actually runs.
		if (mode === "auto") {
			const recordedInput =
				normalizedTool === "bash" && typeof original === "string"
					? { command: original }
					: (event.input as Record<string, unknown>);
			transcript.push({ kind: "tool", tool: normalizedTool, input: recordedInput });
			capTranscript();
		}

		const result = decide({
			toolName: event.toolName,
			subject: matchSubject,
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

		// (dontAsk is the only mode that denies rather than allows unmatched calls.)
		if (result.decision === "deny") return { block: true, reason: denyReason(result) };

		if (floorReason) {
			// The floor never reaches the classifier. Auto mode is unattended, so a
			// block goes back to the model rather than a per-action prompt (a prompt
			// would hang the session); a non-auto interactive session still prompts,
			// since editing your own settings by hand is legitimate.
			autoConfig ??= loadAutoModeConfig(os.homedir());
			if (mode === "auto" || !ctx.hasUI) {
				logDecision(ctx, { tool: event.toolName, subject, outcome: "block", source: "floor", reason: floorReason });
				return { block: true, reason: DENIED_SAFETY_FLOOR(floorReason) };
			}
			logDecision(ctx, { tool: event.toolName, subject, outcome: "prompt", source: "floor", reason: floorReason });
		} else if (result.decision === "classify") {
			// Auto mode is for unattended runs: a block is returned to the MODEL so it
			// can try a safe alternative — it is never raised as a per-action user
			// prompt. The one exception is the loop-breaker: after repeated blocks the
			// gate pauses and the next call falls through to a resume prompt, so a
			// model grinding against the classifier reaches the user instead of
			// burning the night.
			if (!pauseTracker.isPaused()) {
				const outcome = await runClassifier(
					event.toolName,
					event.input as Record<string, unknown>,
					subject,
					ctx,
					// Protected paths must always be judged; everything else may be cleared
					// by the deterministic containment fast-path.
					result.cause !== "protected-path",
				);
				if (outcome.decision === "allow") {
					pauseTracker.recordAllow();
					return undefined;
				}

				// A timeout was not earned by looping against the gate, so it does not
				// count toward the auto-pause. It is returned to the model as retryable
				// (the call was never judged) rather than prompting — a prompt would
				// hang an unattended session waiting on a classifier that was slow.
				if (outcome.tier === "timeout") {
					return { block: true, reason: BLOCKED_BY_TIMEOUT(outcome.reason) };
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
				// Every classifier block (hard or soft) goes back to the model with the
				// classifier's own reason, so it can find a safe alternative. Auto mode
				// does not hand a soft block to the user as a per-action prompt.
				return { block: true, reason: DENIED_BY_CLASSIFIER(outcome.reason) };
			}
			// Paused: fall through to the resume prompt below.
		}

		// ask
		if (!ctx.hasUI) {
			return { block: true, reason: DENIED_NON_INTERACTIVE };
		}

		const preview = previewSubject(subject);
		// Reaching a prompt from the classify branch only happens when auto mode is
		// paused — this is the resume prompt, not a per-action approval.
		const pausedResume = mode === "auto" && result.decision === "classify";
		const title = floorReason
			? `Auto mode never auto-approves this — ${event.toolName} ${floorReason}.\n\n  ${preview}\n\n  Allow it this once?`
			: pausedResume
				? `Auto mode is paused after repeated blocks — approve to resume.\n\n  ${event.toolName}: ${preview || "(no arguments)"}`
				: result.cause === "protected-path"
				? `Allow ${event.toolName} to write a protected path?\n\n  ${preview}\n\n  This path configures your tooling or this agent, so allow rules do not pre-approve it.`
				: `Allow ${event.toolName}?\n\n  ${preview || "(no arguments)"}`;
		const choice = await serializePrompt(() => ctx.ui.select(title, [YES, YES_SESSION, NO]));

		// The user's answer is itself a gate decision worth recording — it is the
		// ground truth a drifting classifier gets calibrated against.
		if (mode === "auto" && (floorReason || pausedResume)) {
			logDecision(ctx, {
				tool: event.toolName,
				subject,
				outcome: choice === YES || choice === YES_SESSION ? "allow" : "block",
				source: "user",
				reason: floorReason ?? "resume after pause",
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
		const feedback = await serializePrompt(() => ctx.ui.input("What should the agent do instead?", "Optional — press Esc to skip"));
		return {
			block: true,
			reason: feedback?.trim() ? `${DENIED_BY_USER}\n\nThe user said: ${feedback.trim()}` : DENIED_BY_USER,
		};
	});

	/**
	 * Evaluate ONE subagent tool call against the parent's live gate — the bridge
	 * published on SUBAGENT_GATE_CHANNEL. Mirrors the main tool_call handler's
	 * decision flow (mode, rules, safety floor, auto-mode classifier, and an
	 * interactive ask), so a child inherits the parent's mode and hits the real gate
	 * (findings §17.1). Differences from the main path, all deliberate: it never
	 * mutates the parent's live transcript (the child action is appended to a copy
	 * for the classifier) and uses the child's own cwd; child blocks do not COUNT
	 * toward the parent's pauseTracker (a child is bounded by its wall-clock cap
	 * and the hand-back return review instead) but an active pause IS honoured —
	 * a paused session's child calls fall through to the resume prompt; and an ask
	 * prompt renders on the parent's terminal via lastReviewCtx, serialized. No
	 * parent UI reachable → fail closed.
	 */
	const evaluateChildToolCall = async (call: ChildToolCall): Promise<ChildGateDecision> => {
		const ctx = lastReviewCtx;
		const { toolName, input, cwd } = call;
		const normalizedTool = normalizeToolName(toolName);
		const subject = extractSubject(normalizedTool, input);
		const resolvedSubject =
			isWritingTool(normalizedTool) && subject
				? resolveForContainment(toAbsolute(cwd, subject, os.homedir()))
				: undefined;

		const result = decide({
			toolName,
			subject,
			cwd,
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

		const floorReason =
			mode === "auto"
				? safetyControlWrite({ toolName: normalizedTool, input, cwd, home: os.homedir() })
				: undefined;

		if (result.decision === "allow" && !floorReason) return undefined;

		if (result.decision === "deny") return { block: true, reason: denyReason(result) };

		// Auto mode: the classifier screens the child's call, exactly as it screens
		// the main agent's. A block is returned to the child (never a per-action
		// prompt), so it can find a safe alternative — auto mode runs unattended.
		// While the loop-breaker pause is in effect, the classifier is NOT consulted:
		// the call falls through to the resume prompt below, exactly as the main
		// handler's paused branch does — a pause is a full-session stop awaiting the
		// user, and child work must not continue through it unattended.
		if (!floorReason && result.decision === "classify" && !pauseTracker.isPaused()) {
			if (!ctx) return { block: true, reason: DENIED_NON_INTERACTIVE };
			const appendEntry: TranscriptEntry = {
				kind: "tool",
				tool: normalizedTool,
				input: normalizedTool === "bash" ? { command: subject } : input,
			};
			const outcome = await runClassifier(toolName, input, subject, ctx, result.cause !== "protected-path", {
				cwd,
				appendEntry,
				// The child's own turn signal, so an aborted child turn cancels the
				// classifier call; a fresh (never-aborted) signal only if the child
				// didn't supply one, so classify() still gets the signal it expects.
				signal: call.signal ?? new AbortController().signal,
			});
			if (outcome.decision === "allow") return undefined;
			if (outcome.tier === "timeout") return { block: true, reason: BLOCKED_BY_TIMEOUT(outcome.reason) };
			return { block: true, reason: DENIED_BY_CLASSIFIER(outcome.reason) };
		}

		// Safety floor: a write to the gate's own config is NEVER auto-approved and
		// never prompted — in auto mode it is returned to the model, exactly as the
		// main handler does (floorReason is only ever set in auto mode). Prompting it
		// would let an inattentive "Yes" — or a prompt-injected child — defeat the one
		// control the classifier itself can't be trusted to enforce.
		if (floorReason) {
			if (ctx) logDecision(ctx, { tool: toolName, subject, outcome: "block", source: "floor", reason: floorReason });
			return { block: true, reason: DENIED_SAFETY_FLOOR(floorReason) };
		}

		// ask: needs the user. Bubble it to the parent's terminal; no UI → fail closed.
		if (!ctx || !ctx.hasUI) return { block: true, reason: DENIED_NON_INTERACTIVE };
		const preview = previewSubject(subject);
		// Reaching here from the classify branch only happens while auto mode is
		// paused — this is the resume prompt, not a per-action approval.
		const pausedResume = mode === "auto" && result.decision === "classify";
		const title = pausedResume
			? `Auto mode is paused after repeated blocks — approve to resume.\n\n  subagent's ${toolName}: ${preview || "(no arguments)"}`
			: result.cause === "protected-path"
				? `Allow a subagent's ${toolName} to write a protected path?\n\n  ${preview}\n\n  This path configures your tooling or this agent, so allow rules do not pre-approve it.`
				: `Allow a subagent's ${toolName}?\n\n  ${preview || "(no arguments)"}`;
		const choice = await serializePrompt(() => ctx.ui.select(title, [YES, YES_SESSION, NO]));

		if (pausedResume) {
			logDecision(ctx, {
				tool: toolName,
				subject,
				outcome: choice === YES || choice === YES_SESSION ? "allow" : "block",
				source: "user",
				reason: "resume after pause",
			});
			// Approving a prompted call is what resumes a paused auto mode.
			if (choice === YES || choice === YES_SESSION) {
				pauseTracker.resume();
				applyBadge();
			}
		}

		if (choice === YES) return undefined;
		if (choice === YES_SESSION) {
			const rule = normalizedTool === "bash" && subject ? parseRule(`bash(${subject})`) : parseRule(normalizedTool);
			if (rule) sessionAllows.push(rule);
			return undefined;
		}
		const feedback = await serializePrompt(() => ctx.ui.input("What should the agent do instead?", "Optional — press Esc to skip"));
		return {
			block: true,
			reason: feedback?.trim() ? `${DENIED_BY_USER}\n\nThe user said: ${feedback.trim()}` : DENIED_BY_USER,
		};
	};

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
	 * surfaces a warning rather than blocking it: the work has already happened, so
	 * the useful move is to make sure the model and the user see it.
	 */
	const reviewFlagged = (reason: string) =>
		`<system-reminder>\nAuto mode reviewed this subagent's actions after it finished and flagged a concern: ${reason}\n\nTreat its output as unverified, do not act on it without checking, and tell the user what it did.\n</system-reminder>`;

	// Classify a finished run's action sequence as a whole. Returns the concern to
	// surface, or undefined when the sequence is fine. Shared by the foreground
	// (tool_result) and background (channel) paths.
	const reviewCompletedRun = async (
		actions: ChildAction[],
		ctx: ExtensionContext,
		subject: string,
		signal: AbortSignal | undefined,
	): Promise<string | undefined> => {
		autoConfig ??= loadAutoModeConfig(os.homedir());
		// Present the child's actions as tool entries appended to the session
		// transcript, so the reviewer judges the sequence with the parent's context
		// in view (SESSION LINKING). reviewOnly runs a single stage-2 full-eval —
		// there is no harm floor to short-circuit for a run that already happened.
		const childEntries: TranscriptEntry[] = actions.map((action) => {
			const tool = normalizeToolName(action.toolName);
			return { kind: "tool", tool, input: tool === "bash" ? { command: action.subject } : { subject: action.subject } };
		});
		const verdict = await classify(
			{
				toolName: "subagent-review",
				transcript: [...transcript, ...childEntries],
				userMessages: [...userMessages],
				claudeMd: instructionsFor(ctx.cwd),
				username: classifierUsername,
				environment: autoConfig.environment,
				// AutoModeConfig is structurally a RuleExtras (hardDeny/softDeny/allow).
				ruleExtras: autoConfig,
			},
			{
				registry: ctx.modelRegistry,
				sessionModel: ctx.model,
				config: autoConfig,
				signal,
				state: classifierState,
				onNotice: (message, level) => ctx.ui.notify(message, level),
				reviewOnly: true,
			},
		);
		logDecision(ctx, {
			tool: "Agent",
			subject,
			outcome: verdict.decision,
			source: "review",
			tier: verdict.tier,
			ruleId: verdict.ruleId,
			reason: verdict.reason || undefined,
		});
		if (verdict.decision === "allow") return undefined;
		pauseTracker.recordBlock({
			toolName: "Agent",
			subject,
			reason: verdict.reason,
			tier: verdict.tier,
			ruleId: verdict.ruleId,
			raw: verdict.raw,
		});
		return verdict.reason;
	};

	const childActions = new Map<string, ChildAction[]>();
	pi.events.on(SUBAGENT_ACTIONS_CHANNEL, (data) => {
		const payload = data as SubagentActionsPayload | undefined;
		if (!payload || !Array.isArray(payload.actions)) return;
		if (!payload.background) {
			// Foreground: hold the actions until the spawning call's tool_result.
			if (payload.toolCallId) childActions.set(payload.toolCallId, payload.actions);
			return;
		}
		// Background/resident: the spawning call already returned, so there is no
		// tool_result to attach to. Review now and surface any concern as its own
		// follow-up, alongside the completion report the model receives.
		const ctx = lastReviewCtx;
		if (mode !== "auto" || payload.actions.length === 0 || pauseTracker.isPaused() || !ctx) return;
		const label = payload.agentName ? `${payload.agentName} (background run)` : "background run";
		void reviewCompletedRun(payload.actions, ctx, label, new AbortController().signal).then((reason) => {
			if (!reason) return;
			pi.sendMessage(
				{ customType: "subagent-review", content: [{ type: "text", text: reviewFlagged(reason) }], display: true, details: {} },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		lastReviewCtx = ctx;
		const actions = childActions.get(event.toolCallId);
		if (actions) childActions.delete(event.toolCallId);
		if (mode !== "auto" || !actions?.length || pauseTracker.isPaused()) return undefined;
		const reason = await reviewCompletedRun(actions, ctx, "completed run", ctx.signal);
		if (!reason) return undefined;
		return { content: [{ type: "text" as const, text: reviewFlagged(reason) }, ...event.content] };
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
			// Stamp the session's containment so a later session on another provider
			// treats this cross-provider setting as stale (parity with /subagent).
			persistClassifierModel(resolved, os.homedir(), ctx.model ? modelIdentity(ctx.model).containment : undefined);
		} catch (error) {
			ctx.ui.notify(`Could not save classifier model: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		resetClassifierChoice();
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
			resetClassifierChoice();
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

	/**
	 * `/auto-mode setup` — Claude Code's setup-wizard flow: ask how this
	 * environment is used, gather facts (git/gh/CLAUDE.md, opt-in shell
	 * history), have a capable model draft the Environment slots and rule
	 * extras, review, persist to user settings, then audit permissions.allow
	 * for rules that skip the classifier entirely.
	 */
	const handleSetupSubcommand = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/auto-mode setup is interactive — run it in a live session.", "warning");
			return;
		}
		const usage = await ctx.ui.select("How do you use One Code in this environment?", [
			"Software development in this repo",
			"Mixed — coding and general tasks",
			"Mostly questions and analysis",
		]);
		if (!usage) return;
		const history = await ctx.ui.select("Also scan recent shell history? (stays local except the drafting call; secrets are redacted)", [
			"Yes",
			"No",
		]);
		if (!history) return;

		ctx.ui.notify("Gathering environment facts (git, gh, CLAUDE.md)…", "info");
		const facts = await gatherFacts({
			cwd: ctx.cwd,
			home: os.homedir(),
			username: classifierUsername,
			usage,
			includeShellHistory: history === "Yes",
		});
		ctx.ui.notify("Drafting the auto-mode setup — this can take a minute…", "info");
		let draft: Awaited<ReturnType<typeof draftSetup>>;
		try {
			draft = await draftSetup(facts, {
				registry: ctx.modelRegistry,
				sessionModel: ctx.model,
				config: autoConfig ?? loadAutoModeConfig(os.homedir()),
				defaultEnvironment: DEFAULT_ENVIRONMENT,
				signal: ctx.signal,
				onNotice: (message, level) => ctx.ui.notify(message, level),
			});
		} catch (error) {
			ctx.ui.notify(`Auto-mode setup failed: ${(error as Error).message}. Nothing was written.`, "warning");
			return;
		}

		ctx.ui.notify(`Proposed auto-mode setup\n\n${renderProposal(draft)}`, "info");
		const decision = await ctx.ui.select("Save this auto-mode setup to ~/.claude/settings.json?", [
			"Looks good — save it",
			"Discard",
		]);
		if (decision === "Looks good — save it") {
			try {
				persistAutoModeSetup(settingsPatch(draft), os.homedir());
			} catch (error) {
				ctx.ui.notify(`Could not write user settings: ${(error as Error).message}`, "warning");
				return;
			}
			autoConfig = loadAutoModeConfig(os.homedir());
			ctx.ui.notify("Saved. /auto-mode config shows the effective setup.", "info");
		} else {
			ctx.ui.notify("Discarded — nothing was written.", "info");
		}

		// CC's "rules that skip checks": broad permissions.allow entries bypass the
		// classifier whether or not the setup above was saved, so the audit runs
		// either way.
		const flagged = auditPermissionAllow(facts.permissionsAllow);
		if (flagged.length === 0) return;
		ctx.ui.notify(
			"These permissions.allow entries in your user settings are broad enough that matching commands never reach auto mode's checks:\n" +
				flagged.map((entry) => `  · ${entry.rule} — ${entry.why}`).join("\n") +
				"\nRemoved entries can be restored by re-adding them verbatim.",
			"warning",
		);
		const act = await ctx.ui.select("Remove them from user settings?", ["Remove them all", "Leave them"]);
		if (act === "Remove them all") {
			try {
				const removed = removeUserPermissionAllow(
					flagged.map((entry) => entry.rule),
					os.homedir(),
				);
				ctx.ui.notify(`Removed ${removed} allow ${removed === 1 ? "entry" : "entries"} from user settings.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not update user settings: ${(error as Error).message}`, "warning");
			}
		}
	};

	pi.registerCommand("auto-mode", {
		description: "Auto-mode classifier: /auto-mode [setup|defaults|config|model [provider/model-id|clear]]",
		getArgumentCompletions: () =>
			[
				{ value: "setup", label: "analyze this environment and draft the config" },
				{ value: "config", label: "effective environment" },
				{ value: "defaults", label: "built-in environment" },
				{ value: "model", label: "choose the classifier model" },
			],
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "model") {
				await handleModelSubcommand(rest.join(" ").trim(), ctx);
				return;
			}
			if (sub === "setup") {
				await handleSetupSubcommand(ctx);
				return;
			}
			const which = sub ?? "config";
			if (which !== "defaults" && which !== "config") {
				ctx.ui.notify(
					`Unknown subcommand "${which}". Use: /auto-mode setup | defaults | config | model [provider/model-id|clear]`,
					"warning",
				);
				return;
			}
			// "defaults" prints the built-in Environment; "config" prints what the
			// classifier actually uses, with $defaults already spliced in. The rule
			// set's prose is Claude Code's fixed monolith and is not shown here — the
			// customization surface is the Environment plus the append-only
			// hard_deny/soft_deny/allow rule extras (the same schema Claude Code's
			// /auto-mode-setup writes; those settings work here unchanged). The
			// config view re-reads disk so it shows the file as it is now, and
			// refreshes the cached copy.
			const loaded = which === "config" ? loadAutoModeConfigWithDiagnostics(os.homedir()) : undefined;
			if (loaded) autoConfig = loaded.config;
			const shown = loaded ? loaded.config : { environment: DEFAULT_ENVIRONMENT };
			const section = (title: string, entries: string[]) =>
				`${title} (${entries.length}):\n${entries.map((entry) => `  - ${entry}`).join("\n")}`;
			const ruleSections =
				loaded && "hardDeny" in shown
					? (
							[
								["extra hard_deny rules", shown.hardDeny],
								["extra soft_deny rules", shown.softDeny],
								["extra allow rules", shown.allow],
							] as const
						)
							.filter(([, entries]) => entries.length > 0)
							.map(([title, entries]) => section(title, entries))
					: [];
			ctx.ui.notify(
				[
					which === "config"
						? `read from: ${autoModeSettingsPaths(os.homedir()).join(", ")}\n(project settings are deliberately not read — a repo could otherwise grant itself permissions)`
						: 'built-in environment; add "$defaults" to autoMode.environment in settings to keep it while adding your own',
					"The built-in ruleset is Claude Code's fixed classifier ruleset (not shown); customize via the environment and the append-only hard_deny/soft_deny/allow extras.",
					section("environment", shown.environment),
					...ruleSections,
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
