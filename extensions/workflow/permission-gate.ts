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
import { decide, extractSubject, normalizeToolName, parseRules } from "../permissions/matcher.ts";
import { loadPermissionSettings } from "../permissions/settings.ts";

/** Tools the workflow runtime itself injects into subagents; never gate them. */
const WORKFLOW_INTERNAL_TOOLS = new Set(["structured_output"]);

export function permissionGateFactory(cwd: string, home: string): InlineExtension {
	const settings = loadPermissionSettings(cwd, home);
	const deny = parseRules(settings.deny);
	const allow = parseRules(settings.allow);
	const mode = settings.defaultMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits";

	return {
		name: "workflow-permission-gate",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", (event) => {
				if (WORKFLOW_INTERNAL_TOOLS.has(event.toolName)) return undefined;
				const subject = extractSubject(normalizeToolName(event.toolName), event.input as Record<string, unknown>);
				const result = decide({ toolName: event.toolName, subject, cwd, mode, deny, ask: [], allow });
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
