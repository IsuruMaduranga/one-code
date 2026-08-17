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
 * Policy: deny rules always win; explicit allow rules allow; edits are
 * auto-allowed (Claude Code runs these agents in acceptEdits); anything that
 * would normally *ask* is denied — there is no interactive prompt inside an
 * in-process agent, and fail-closed beats silently trusting the model.
 *
 * `neverGate` names tools the runtime itself injects (e.g. `structured_output`,
 * the child-only `SendMessage`-to-main tool) that must never be gated.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "./git.ts";
import { memoryDir } from "./memory.ts";
import { sessionScratchpadDir } from "./scratchpad.ts";
import { decide, extractSubject, normalizeToolName, parseRules } from "../permissions/matcher.ts";
import { loadPermissionSettings } from "../permissions/settings.ts";
import type { PermissionBridge } from "../permissions/subagent-gate.ts";

/** Tools the runtime itself injects; never gate them. */
const DEFAULT_INTERNAL_TOOLS = new Set(["structured_output"]);

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
	 * absent for the workflow runner and headless runs, which keep the local gate.
	 */
	getBridge?: () => PermissionBridge | undefined,
): InlineExtension {
	const settings = loadPermissionSettings(cwd, home);
	const deny = parseRules(settings.deny);
	const allow = parseRules(settings.allow);
	const mode = settings.defaultMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits";
	// Memory writes work inside agent sessions too — otherwise the protected
	// `.claude` check turns them into "needs interactive approval" and the
	// harness blocks its own feature (same rationale as in decide()).
	const memoryDirPath = memoryDir(home, findGitRoot(cwd) ?? cwd);

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

				// Preferred path: route the call through the parent's real permission
				// pipeline. Everything here — resolving the bridge AND invoking it — fails
				// CLOSED (deny); a broken bridge or getter must never silently open the gate.
				// The child's own signal rides along so an aborted child turn cancels any
				// classifier call the bridge makes.
				try {
					const bridge = getBridge?.();
					if (bridge) {
						const input = (event.input ?? {}) as Record<string, unknown>;
						return await bridge({ toolName: event.toolName, input, cwd: runCwd, signal: ctx?.signal });
					}
				} catch (error) {
					return { block: true, reason: `Permission bridge failed (${(error as Error).message}); denied to fail safe.` };
				}

				const sessionId = ctx?.sessionManager?.getSessionId?.();
				if (!scratchpadDirPath && sessionId) scratchpadDirPath = sessionScratchpadDir(runCwd, sessionId);
				const subject = extractSubject(normalizeToolName(event.toolName), event.input as Record<string, unknown>);
				const result = decide({
					toolName: event.toolName,
					subject,
					cwd: runCwd,
					mode,
					deny,
					ask: [],
					allow,
					memoryDirPath,
					scratchpadDirPath,
				});
				if (result.decision === "allow") return undefined;
				const ruleNote = result.rule ? ` (rule: ${result.rule.raw})` : "";
				return {
					block: true,
					reason:
						result.decision === "deny"
							? `Denied by permission rules${ruleNote}.`
							: "This action needs interactive approval, which is not available inside an in-process agent. Ask for it to be added to the allow rules, or work around it.",
				};
			});
		},
	};
}
