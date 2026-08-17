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

/** Tools the runtime itself injects; never gate them. */
const DEFAULT_INTERNAL_TOOLS = new Set(["structured_output"]);

export function permissionGateFactory(cwd: string, home: string, neverGate: Set<string> = DEFAULT_INTERNAL_TOOLS): InlineExtension {
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
			pi.on("tool_call", (event, ctx) => {
				if (neverGate.has(event.toolName)) return undefined;
				// Resolve against the running session's cwd, not the build-time cwd:
				// a worktree-isolated run executes under the worktree path, and its
				// path/scratchpad checks must match that, not the original project dir.
				const runCwd = ctx?.cwd ?? cwd;
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
