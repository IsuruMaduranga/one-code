/**
 * bash extension — Claude Code's Bash `run_in_background` on top of pi's own
 * bash tool.
 *
 * Registering a tool named `bash` overrides the built-in (findings §2), which
 * is how pi's official sandbox example does it too. The foreground path
 * delegates to pi's real executor (`createBashToolDefinition`) so upstream
 * bash behavior — timeout handling, truncation, PI_* env, spawn hooks — stays
 * exactly pi's; the shared body in lib/shell-tool.ts adds the background
 * branch (spool to `<sessionDir>/bash/<taskId>/output.log`, the shared
 * background registry, a steered completion notification), and this file only
 * supplies what is bash's: pi's definition, the bash the session resolved
 * (lib/shell-spawn.ts — Git Bash on Windows, `CLAUDE_CODE_GIT_BASH_PATH`
 * honoured), the CC-shaped description and the bash guards. The permission
 * gate and auto-mode classifier run before execute like any bash call — a
 * background command is NOT auto-allowed, and the gate fires before anything
 * detaches.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { perCwd } from "../lib/per-cwd.ts";
import { bashSpawn } from "../lib/shell-spawn.ts";
import { registerShellTool } from "../lib/shell-tool.ts";
import { bashGuardReason } from "./guards.ts";

const BashParams = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds (max 600000)" })),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run detached and return a task id immediately instead of waiting. Completion arrives as a task notification; inspect with task_output, stop with task_stop. Use this instead of nohup/'&' — those leave an unmanaged orphan process",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "5-10 word description of what the command does (shown in notifications)" }),
	),
});

export default function bashExtension(pi: ExtensionAPI) {
	// The session's bash, resolved once (lib/shell-spawn.ts). An ignored
	// CLAUDE_CODE_GIT_BASH_PATH is reported once, at the first session start.
	const bash = bashSpawn();
	const shellPath = bash.spawn?.commandTransport === "stdin" ? undefined : bash.spawn?.shell;
	let warned = false;
	pi.on("session_start", (_event, ctx) => {
		if (warned || !bash.warning) return;
		warned = true;
		if (ctx.hasUI) ctx.ui.notify(bash.warning, "warning");
		else process.stderr.write(`${bash.warning}\n`);
	});

	// pi's definition supplies the description and TUI renderers; the executor
	// is re-created per working directory because it closes over cwd (worktree
	// switches change ctx.cwd mid-session). The same bash drives pi's foreground
	// executor, so the override applies there too.
	const base = createBashToolDefinition(process.cwd(), { shellPath });
	// pi's base sentence is "Optionally provide a timeout in seconds." — but the
	// `timeout` parameter and the execute path both use milliseconds (Claude
	// Code's Bash unit; the executor divides by 1000). The two must not
	// contradict, or a model that trusts the description sends `timeout: 120`
	// and gets a 120 ms deadline (TOOL-FIDELITY-REVIEW-2026-09-07 H3). Swap in
	// CC's Bash sentence.
	const baseDescription = base.description.replace(
		"Optionally provide a timeout in seconds.",
		"`timeout` is in milliseconds: default 120000, max 600000.",
	);

	registerShellTool(pi, {
		name: "bash",
		ccLabel: "Bash",
		description: `${baseDescription} Pass run_in_background: true for long-running commands (builds, servers, watches): it returns a task id immediately so you can keep working, completion arrives as a task notification, and the output is retrievable with task_output / stoppable with task_stop (both deferred — load them with tool_search; in a one-shot print/json session the call runs to completion and returns the output directly). Foreground \`sleep\` is blocked; to wait on a condition use the monitor tool (deferred — load it with tool_search select:monitor) with an until-loop.`,
		parameters: BashParams,
		base,
		foreground: perCwd((cwd: string) => createBashToolDefinition(cwd, { shellPath })),
		guard: bashGuardReason,
		backgroundShell: () => bash.spawn,
	});
}
