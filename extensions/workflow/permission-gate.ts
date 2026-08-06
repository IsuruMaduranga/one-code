/**
 * Permission gate for workflow subagents (pure).
 *
 * Workflow subagent sessions are built with `noExtensions: true`, so pincer's
 * own permissions extension never loads inside them — without this gate every
 * subagent bash/edit/write would run unchecked. `DefaultResourceLoader` always
 * loads explicitly passed `extensionFactories` (even under noExtensions),
 * which is where this inline factory attaches.
 *
 * Policy: deny rules always win; explicit allow rules allow; edits are
 * auto-allowed (Claude Code runs workflow subagents in acceptEdits); anything
 * that would normally *ask* is denied — there is no interactive prompt inside
 * an agent() call, and fail-closed beats silently trusting the model.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "../lib/git.ts";
import { memoryDir } from "../lib/memory.ts";
import { sessionScratchpadDir } from "../lib/scratchpad.ts";
import { decide, extractSubject, normalizeToolName, parseRules } from "../permissions/matcher.ts";
import { loadPermissionSettings } from "../permissions/settings.ts";

/** Tools the workflow runtime itself injects into subagents; never gate them. */
const WORKFLOW_INTERNAL_TOOLS = new Set(["structured_output"]);

export function permissionGateFactory(cwd: string, home: string): InlineExtension {
	const settings = loadPermissionSettings(cwd, home);
	const deny = parseRules(settings.deny);
	const allow = parseRules(settings.allow);
	const mode = settings.defaultMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits";
	// Memory writes work inside agent() calls too — otherwise the protected
	// `.claude` check turns them into "needs interactive approval" and the
	// harness blocks its own feature (same rationale as in decide()).
	const memoryDirPath = memoryDir(home, findGitRoot(cwd) ?? cwd);

	return {
		name: "workflow-permission-gate",
		hidden: true,
		factory: (pi) => {
			// The scratchpad embeds the *child's* session id, which does not exist
			// until the session runs — derived on first tool call, then pinned.
			let scratchpadDirPath: string | undefined;
			pi.on("tool_call", (event, ctx) => {
				if (WORKFLOW_INTERNAL_TOOLS.has(event.toolName)) return undefined;
				const sessionId = ctx?.sessionManager?.getSessionId?.();
				if (!scratchpadDirPath && sessionId) scratchpadDirPath = sessionScratchpadDir(cwd, sessionId);
				const subject = extractSubject(normalizeToolName(event.toolName), event.input as Record<string, unknown>);
				const result = decide({
					toolName: event.toolName,
					subject,
					cwd,
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
							: "This action needs interactive approval, which is not available inside a workflow agent. Ask for it to be added to the allow rules, or work around it.",
				};
			});
		},
	};
}
