/**
 * bash extension — Claude Code's Bash `run_in_background` on top of pi's own
 * bash tool.
 *
 * Registering a tool named `bash` overrides the built-in (findings §2), which
 * is how pi's official sandbox example does it too. The foreground path
 * delegates to pi's real executor (`createBashToolDefinition`) so upstream
 * bash behavior — timeout handling, PI_* env, spawn hooks — stays exactly
 * pi's (its tail cut of a long output is replaced by Claude Code's head-first
 * one, lib/shell-run/spill-file.ts); the shared body in lib/shell-run/shell-tool.ts adds the background
 * branch (spool to `<sessionDir>/bash/<taskId>/output.log`, the shared
 * background registry, a steered completion notification), and this file only
 * supplies what is bash's: pi's definition, the bash the session resolved
 * (lib/shell-run/shell-spawn.ts — Git Bash on Windows, `CLAUDE_CODE_GIT_BASH_PATH`
 * honoured), Claude Code's description (description.ts) and the bash guards. The permission
 * gate and auto-mode classifier run before execute like any bash call — a
 * background command is NOT auto-allowed, and the gate fires before anything
 * detaches.
 */

import { feature } from "../../lib/profile/feature.ts";
import { join } from "node:path";
import type { BashSpawnContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childProcessEnv, LAUNCHER_ENV_VAR } from "../../lib/app/app-launch.mjs";
import { perCwd } from "../../lib/core/per-cwd.ts";
import { bashSpawn, piShellEnv, withChildProcessEnv } from "../../lib/shell-run/shell-spawn.ts";
import { registerShellTool } from "../../lib/shell-run/shell-tool.ts";
import { type DescriptionForm, followDescriptionForm } from "../../lib/profile/tool-variants.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../lib/rules/modes.ts";
import type { ShellParams } from "../../lib/shell-run/shell-text.ts";
import { requireText } from "../../lib/profile/profile.ts";
import { childShellWords, childText } from "../../lib/agents/child-extensions.ts";
import { bashGuardReason } from "../../lib/shell/bash-guards.ts";

/** The tool's parameters, described in the profile's words. */
const bashParams = (d: ShellParams) =>
	Type.Object({
		command: Type.String({ description: d.command }),
		timeout: Type.Optional(Type.Number({ description: d.timeout })),
		description: Type.Optional(Type.String({ description: d.description })),
		run_in_background: Type.Optional(Type.Boolean({ description: d.run_in_background })),
	});

function bashExtension(pi: ExtensionAPI) {
	bashTool(pi, { announce: true });
}

/**
 * The tool itself. `announce: false` is the in-process child's shape
 * (tools/bash/child.ts): the same tool, but a child has no terminal of its own
 * (stderr is the parent's TUI), so it prints nothing.
 */
export function bashTool(pi: ExtensionAPI, { announce, child = false }: { announce: boolean; child?: boolean }) {
	// The session's bash, resolved once (lib/shell-run/shell-spawn.ts). An ignored
	// CLAUDE_CODE_GIT_BASH_PATH is reported once, at the first session start.
	const bash = bashSpawn();
	const shellPath = bash.spawn?.commandTransport === "stdin" ? undefined : bash.spawn?.shell;
	let warned = false;
	if (announce) pi.on("session_start", (_event, ctx) => {
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
	// the bundled app (lib/app/app-launch.mjs), so a `pi` it starts is the user's pi.
	const spawnHook = (context: BashSpawnContext): BashSpawnContext => ({ ...context, env: childProcessEnv(context.env) });
	const base = createBashToolDefinition(process.cwd(), { shellPath, spawnHook });

	// The description follows the tier and the permission mode. It reaches the
	// wire only when a request opens an epoch: inside one the ledger keeps the
	// tools array as recorded (extensions/request/ledger), so a mode switch never moves
	// the tool or re-caches the prefix; mode reminders and the live permission
	// gate carry the change instead.
	let form: DescriptionForm = "short";
	// Tiny's dedicated search tools replace the long form's shell-find advice.
	let searchTools = false;
	let autoMode = false;
	// A child's words name only the tools every child has (lib/agents/child-extensions.ts).
	const text = child ? (childText().shell ?? requireText("shell")) : requireText("shell");
	const describe = () => text.bashDescription({ form, autoMode, searchTools });
	const setDescription = registerShellTool(pi, {
		name: "bash",
		ccLabel: "Bash",
		description: describe(),
		parameters: bashParams(text.bashParams),
		base,
		foreground: perCwd((cwd: string) => createBashToolDefinition(cwd, { shellPath, spawnHook })),
		guard: bashGuardReason,
		...(child ? { words: childShellWords } : {}),
		backgroundShell: () => bash.spawn,
	});
	followDescriptionForm(pi, (next, tier) => {
		form = next;
		searchTools = tier === "tiny";
		setDescription(describe());
	});
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		const next = (data as PermissionStatus).mode === "auto";
		if (next === autoMode) return;
		autoMode = next;
		setDescription(describe());
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

export default feature("bash", bashExtension);
