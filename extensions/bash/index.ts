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
 * honoured), Claude Code's description (description.ts) and the bash guards. The permission
 * gate and auto-mode classifier run before execute like any bash call — a
 * background command is NOT auto-allowed, and the gate fires before anything
 * detaches.
 */

import { join } from "node:path";
import type { BashSpawnContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childProcessEnv, LAUNCHER_ENV_VAR } from "../lib/app-launch.mjs";
import { perCwd } from "../lib/per-cwd.ts";
import { bashSpawn, piShellEnv, withChildProcessEnv } from "../lib/shell-spawn.ts";
import { registerShellTool } from "../lib/shell-tool.ts";
import { type DescriptionForm, followDescriptionForm } from "../lib/tool-variants.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../permissions/modes.ts";
import { BASH_PARAMS, bashDescription } from "./description.ts";
import { bashGuardReason } from "./guards.ts";

const BashParams = Type.Object({
	command: Type.String({ description: BASH_PARAMS.command }),
	timeout: Type.Optional(Type.Number({ description: BASH_PARAMS.timeout })),
	description: Type.Optional(Type.String({ description: BASH_PARAMS.description })),
	run_in_background: Type.Optional(Type.Boolean({ description: BASH_PARAMS.run_in_background })),
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

	// pi's definition supplies the TUI renderers; the executor is re-created
	// per working directory because it closes over cwd (worktree switches
	// change ctx.cwd mid-session). The same bash drives pi's foreground
	// executor, so the override applies there too.
	// Every command the model runs gets the user's own environment back under
	// the bundled app (lib/app-launch.mjs), so a `pi` it starts is the user's pi.
	const spawnHook = (context: BashSpawnContext): BashSpawnContext => ({ ...context, env: childProcessEnv(context.env) });
	const base = createBashToolDefinition(process.cwd(), { shellPath, spawnHook });

	// Claude Code's Bash text (description.ts): its form follows the model's
	// tier, and the short form's "avoid cat/head/…" bullet is left out in auto
	// mode. Permissions loads first and announces the mode at session start, so
	// the first request already carries the right text.
	let form: DescriptionForm = "short";
	let autoMode = false;
	const setDescription = registerShellTool(pi, {
		name: "bash",
		ccLabel: "Bash",
		description: bashDescription(form, autoMode),
		parameters: BashParams,
		base,
		foreground: perCwd((cwd: string) => createBashToolDefinition(cwd, { shellPath, spawnHook })),
		guard: bashGuardReason,
		backgroundShell: () => bash.spawn,
	});
	followDescriptionForm(pi, (next) => {
		form = next;
		setDescription(bashDescription(form, autoMode));
	});
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		autoMode = (data as PermissionStatus).mode === "auto";
		setDescription(bashDescription(form, autoMode));
	});

	// The user's own `!` commands, under the bundled app only: pi runs them with
	// its full process environment, so they get the same restore. Outside the app
	// pi's default path runs untouched. They run in the session's bash, the one
	// the bash tool uses.
	pi.on("user_bash", () => {
		if (process.env[LAUNCHER_ENV_VAR] === undefined) return undefined;
		return { operations: withChildProcessEnv(createLocalBashOperations({ shellPath }), () => piShellEnv(join(getAgentDir(), "bin"))) };
	});
}
