/**
 * Permission gate for in-process agent sessions (pure), shared by the workflow
 * and subagent runners.
 *
 * In-process agent sessions are built with `noExtensions: true`, so One Code's
 * own permissions extension never loads inside them — without this gate every
 * subagent bash/edit/write would run unchecked. `DefaultResourceLoader` always
 * loads explicitly passed `extensionFactories` (even under noExtensions),
 * which is where this inline factory attaches.
 *
 * Primary path: every tool call is routed through the parent's permission
 * BRIDGE (`permissions/subagent-gate.ts`) — the parent's live mode, rules,
 * auto-mode classifier and interactive prompts, exactly as the main agent's
 * calls are judged (Claude Code parity, findings §17.1). Resolving or invoking
 * the bridge fails CLOSED.
 *
 * Local fallback (no bridge — workflow/headless runs, or a parent without the
 * permissions extension): deny rules always win; explicit allow rules allow;
 * the mode is the parent session's live mode (published as CC_PERMISSION_MODE,
 * read per call), else the settings' defaultMode, else acceptEdits (Claude Code
 * runs these agents in acceptEdits); ask rules are honoured; anything that
 * would normally *ask* is denied — there is no interactive prompt inside an
 * in-process agent, and fail-closed beats silently trusting the model. Auto
 * mode has no classifier here, so it degrades to acceptEdits, which decide()
 * confines to the cwd (as it does reads); the rest is denied. Project-scope
 * allow rules apply only with a stored consent (project-trust.ts).
 *
 * `neverGate` names tools the runtime itself injects (e.g. `structured_output`,
 * the child-only `SendMessage`-to-main tool) that must never be gated.
 */

import { getAgentDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { findProjectRoot } from "./git.ts";
import { memoryDir } from "./memory.ts";
import { sessionResultsDir } from "./persisted-output.ts";
import { sessionScratchpadDir } from "./scratchpad.ts";
import { decide, extractSubject, isPathSubjectTool, normalizeToolName, type PermissionMode, parseRules } from "../permissions/matcher.ts";
import { projectAllowApproved } from "../permissions/project-trust.ts";
import { loadPermissionSettings, normalizePermissionMode } from "../permissions/settings.ts";
import type { PermissionBridge } from "../permissions/subagent-gate.ts";
import { resolveForContainment, toAbsolute } from "../auto-mode/paths.ts";

/** A directory's realpath for containment, or the path itself when nothing about it resolves. */
export const resolvedOrSelf = (dir: string) => resolveForContainment(dir) ?? dir;

/**
 * Directories protected at runtime, beyond protected-paths.ts's static list:
 * pi's own agent directory (`getAgentDir()` — `~/.pi/agent` for stock pi,
 * `~/.onecode/agent` bundled), whose extensions, settings and auth are code
 * and credentials the harness loads. Literal and resolved spelling, so both
 * the raw and the realpath'd subject match. One definition for both gates
 * (PERMISSIONS-REVIEW-2026-09-05 M7).
 */
export function runtimeProtectedDirs(): string[] {
	const agentDir = getAgentDir();
	return [...new Set([agentDir, resolvedOrSelf(agentDir)])];
}

/** Tools the runtime itself injects; never gate them. */
const DEFAULT_INTERNAL_TOOLS = new Set(["structured_output"]);

/** The parent permissions extension publishes its live mode here (in-process children read it). */
export const MODE_ENV = "CC_PERMISSION_MODE";

/**
 * The mode the local gate judges under: the parent's published live mode, else
 * the settings' defaultMode, else Claude Code's subagent default. Pure, for tests.
 */
export function localGateMode(envValue: string | undefined, defaultMode: PermissionMode | undefined): PermissionMode {
	return normalizePermissionMode(envValue) ?? defaultMode ?? "acceptEdits";
}

export function permissionGateFactory(
	cwd: string,
	home: string,
	neverGate: Set<string> = DEFAULT_INTERNAL_TOOLS,
	/**
	 * The parent permissions extension's decision closure. When present, a child's
	 * tool calls are gated through the REAL parent pipeline (mode inheritance,
	 * auto-mode classifier, prompts bubbled to the user — Claude Code parity,
	 * findings §17.1) rather than the fail-closed local rules below. A getter so it
	 * can be read at call time (the bridge may be published after the loader builds);
	 * absent only for headless runs with no publishing parent, which keep the local gate.
	 */
	getBridge?: () => PermissionBridge | undefined,
): InlineExtension {
	const settings = loadPermissionSettings(cwd, home);
	const deny = parseRules(settings.deny);
	const ask = parseRules(settings.ask);
	// The repository the run belongs to: an isolation worktree shares its main
	// checkout's consent and memory (findProjectRoot), not a throwaway slug.
	const projectRoot = findProjectRoot(cwd) ?? cwd;
	// Repo-shipped allow rules count only once the user has consented to exactly
	// this list (the parent session's dialog); there is no one to ask here.
	const allow = parseRules(
		projectAllowApproved(projectRoot, settings.projectAllow) ? [...settings.allow, ...settings.projectAllow] : settings.allow,
	);
	// Memory writes work inside agent sessions too — otherwise the protected
	// `.claude` check turns them into "needs interactive approval" and the
	// harness blocks its own feature (same rationale as in decide()).
	const memoryDirPath = memoryDir(home, projectRoot);
	const protectedDirs = runtimeProtectedDirs();

	return {
		name: "agent-permission-gate",
		hidden: true,
		factory: (pi) => {
			// The scratchpad embeds the *child's* session id, which does not exist
			// until the session runs — derived on first tool call, then pinned.
			let scratchpadDirPath: string | undefined;
			pi.on("tool_call", async (event, ctx) => {
				if (neverGate.has(event.toolName)) return undefined;
				const runCwd = ctx?.cwd ?? cwd;
				const sessionId = ctx?.sessionManager?.getSessionId?.();

				// Preferred path: route the call through the parent's real permission
				// pipeline. Everything here — resolving the bridge AND invoking it — fails
				// CLOSED (deny); a broken bridge or getter must never silently open the gate.
				// The child's own signal rides along so an aborted child turn cancels any
				// classifier call the bridge makes and dismisses a prompt it bubbled; the
				// session id lets the runner name the asking agent in that prompt.
				try {
					const bridge = getBridge?.();
					if (bridge) {
						const input = (event.input ?? {}) as Record<string, unknown>;
						return await bridge({
							toolName: event.toolName,
							input,
							cwd: runCwd,
							signal: ctx?.signal,
							sessionId,
						});
					}
				} catch (error) {
					return { block: true, reason: `Permission bridge failed (${(error as Error).message}); denied to fail safe.` };
				}

				if (!scratchpadDirPath && sessionId) scratchpadDirPath = sessionScratchpadDir(runCwd, sessionId);
				const tool = normalizeToolName(event.toolName);
				const subject = extractSubject(tool, event.input as Record<string, unknown>);
				// Path tools (writers and the read tier) are judged by where the path
				// resolves; both sides resolved (macOS /var → /private/var) so a real
				// in-cwd path is not misjudged as an escape.
				const resolvedSubject =
					isPathSubjectTool(tool) && subject ? resolveForContainment(toAbsolute(runCwd, subject, home)) : undefined;
				// Read per call: the parent may cycle modes while a child runs.
				const liveMode = localGateMode(process.env[MODE_ENV], settings.defaultMode);
				// No classifier is reachable without the bridge, so auto mode is judged
				// as acceptEdits — which decide() confines to the working directory.
				const mode = liveMode === "auto" ? "acceptEdits" : liveMode;
				const result = decide({
					toolName: event.toolName,
					subject,
					cwd: runCwd,
					mode,
					deny,
					ask,
					allow,
					resolvedSubject,
					resolvedCwd: resolveForContainment(runCwd),
					memoryDirPath,
					scratchpadDirPath,
					// The agent's own persisted-output dir: a read of a result it was
					// handed a path to must not be judged an outside read. Resolved like
					// the subject (the tmpdir fallback sits under a symlinked /var on macOS).
					resultsDirPath: resolvedOrSelf(sessionResultsDir(ctx)),
					protectedDirs,
				});
				if (result.decision === "allow") return undefined;
				const ruleNote = result.rule ? ` (rule: ${result.rule.raw})` : "";
				const outside = result.cause === "working-dir" ? " outside the working directory" : "";
				return {
					block: true,
					reason:
						result.decision === "deny"
							? `Denied by permission rules${ruleNote}.`
							: liveMode === "auto"
								? `Auto mode's classifier is only reachable through the parent session, which this agent has no link to; a call${outside} is denied to fail safe.`
								: `This action${outside} needs interactive approval, which is not available inside an in-process agent. Ask for it to be added to the allow rules, or work around it.`,
				};
			});
		},
	};
}
