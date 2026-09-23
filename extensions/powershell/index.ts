/**
 * powershell extension — Claude Code's PowerShell tool on top of pi's own
 * `powershell` built-in (working-docs/decisions/windows.md, findings §22).
 *
 * Registering a tool named `powershell` overrides pi's built-in (findings §2),
 * exactly as `extensions/bash` overrides `bash`, and the shared body in
 * lib/shell-tool.ts supplies the `run_in_background` orchestration for both.
 * The foreground path delegates to pi's real definition
 * (`createPowerShellToolDefinition`) so schema, cwd handling, truncation and
 * streaming stay upstream's — with One Code's own `operations`
 * (lib/shell-spawn.ts), because pi's local operations throw off Windows and
 * this tool is developed against a `pwsh` on this Mac. The description is
 * Claude Code's captured text (description.ts); the guards are the PowerShell
 * spelling of bash's.
 *
 * Activation follows Claude Code's gate (policy.ts): pi never activates a
 * registered override of a built-in name on its own, so `session_start` and
 * `model_select` reconcile the active list — `powershell` on when the policy
 * says so, `bash` off when no bash exists (Windows without Git for Windows).
 * Children get the same reconcile: `openChildSession` binds extensions, which
 * emits `session_start`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { perCwd } from "../lib/per-cwd.ts";
import { bashSpawn, createPowerShellOperations, POWERSHELL_UTF8_PREFIX, powerShellEdition, powerShellSpawn } from "../lib/shell-spawn.ts";
import { registerShellTool } from "../lib/shell-tool.ts";
import { powerShellToolDescription } from "./description.ts";
import { powershellGuardReason } from "./guards.ts";
import { shellToolPolicy, withShellTools } from "./policy.ts";

/** Claude Code's PowerShell schema (captured), minus `dangerouslyDisableSandbox` — One Code has no sandbox to disable. */
const PowerShellParams = Type.Object({
	command: Type.String({ description: "The PowerShell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds (max 600000)" })),
	description: Type.Optional(Type.String({ description: "Clear, concise description of what this command does in active voice." })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run this command in the background." })),
});

export default function powershellExtension(pi: ExtensionAPI) {
	const spec = powerShellSpawn();
	const operations = createPowerShellOperations(() => spec);
	const base = createPowerShellToolDefinition(process.cwd(), { operations });
	const policy = () =>
		shellToolPolicy({ platform: process.platform, env: process.env, bash: !!bashSpawn().spawn, powershell: spec !== undefined });
	const startupPolicy = policy();

	registerShellTool(pi, {
		name: "powershell",
		ccLabel: "PowerShell",
		description: powerShellToolDescription(powerShellEdition(spec)),
		parameters: PowerShellParams,
		base,
		// The guideline joins the system prompt's tool guidelines at registration
		// (before the first request), so it is part of the cached prefix, never a
		// mid-session rebuild. Claude Code names PowerShell the primary shell when
		// the tool is on (2.1.126).
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			...(startupPolicy.primary === "powershell"
				? ["PowerShell is the primary shell on this machine: use the powershell tool for terminal operations (git, npm, build tools)"]
				: []),
		],
		foreground: perCwd((cwd: string) => createPowerShellToolDefinition(cwd, { operations })),
		guard: powershellGuardReason,
		backgroundShell: () => spec,
		// The foreground path prepends pi's UTF-8 prefix inside the operations; the background spawn needs it too.
		wrapBackgroundCommand: (command) => `${POWERSHELL_UTF8_PREFIX}${command}`,
	});

	let noticesShown = false;
	const reconcile = (ctx?: Pick<ExtensionContext, "hasUI" | "ui">) => {
		const current = policy();
		const active = pi.getActiveTools();
		const next = withShellTools(active, current);
		if (next.join(" ") !== active.join(" ")) pi.setActiveTools(next);
		if (noticesShown || current.notices.length === 0) return;
		noticesShown = true;
		for (const notice of current.notices) {
			if (ctx?.hasUI) ctx.ui.notify(notice, "warning");
			else process.stderr.write(`${notice}\n`);
		}
	};

	pi.on("session_start", (_event, ctx) => reconcile(ctx));
	pi.on("model_select", () => reconcile());
}
