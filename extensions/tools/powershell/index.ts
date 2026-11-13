/**
 * powershell extension — Claude Code's PowerShell tool on top of pi's own
 * `powershell` built-in (working-docs/decisions/windows.md, findings §22).
 *
 * Registering a tool named `powershell` overrides pi's built-in (findings §2),
 * exactly as `extensions/tools/bash` overrides `bash`, and the shared body in
 * lib/shell-run/shell-tool.ts supplies the `run_in_background` orchestration for both.
 * The foreground path delegates to pi's real definition
 * (`createPowerShellToolDefinition`) so schema, cwd handling and streaming
 * stay upstream's (a long output is cut Claude Code's way, as for bash) — with One Code's own `operations`
 * (lib/shell-run/shell-spawn.ts), because pi's local operations throw off Windows and
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

import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { perCwd } from "../../lib/core/per-cwd.ts";
import { bashSpawn, createPowerShellOperations, POWERSHELL_TOOL_PREFIX, powerShellEdition, powerShellSpawn } from "../../lib/shell-run/shell-spawn.ts";
import { registerShellTool } from "../../lib/shell-run/shell-tool.ts";
import { sessionView } from "../../lib/agents/child-extensions.ts";
import { shellResultText, type ShellText } from "../../lib/shell-run/shell-text.ts";
import { powershellGuardReason } from "./guards.ts";
import { shellToolPolicy, withShellTools } from "./policy.ts";

/** Claude Code's PowerShell schema (captured), minus `dangerouslyDisableSandbox` — One Code has no sandbox to disable. */
/** The tool's parameters, described in the profile's words. */
const powerShellParams = (d: ShellText["powershellParams"]) => {
	return Type.Object({
		command: Type.String({ description: d.command }),
		timeout: Type.Optional(Type.Number({ description: d.timeout })),
		description: Type.Optional(Type.String({ description: d.description })),
		run_in_background: Type.Optional(Type.Boolean({ description: d.run_in_background })),
	});
};

function powershellExtension(pi: ExtensionAPI) {
	powershellTool(pi, { announce: true });
}

/** The tool itself; `announce: false` is the in-process child's shape (tools/powershell/child.ts), which prints no notices. */
export function powershellTool(pi: ExtensionAPI, { announce }: { announce: boolean }) {
	// A child's words name only the tools every child has (lib/agents/child-extensions.ts).
	const view = sessionView(pi);
	const text = view.text("shell");
	const spec = powerShellSpawn();
	const operations = createPowerShellOperations(() => spec);
	const base = createPowerShellToolDefinition(process.cwd(), { operations });
	const policy = () =>
		shellToolPolicy({ platform: process.platform, env: process.env, bash: !!bashSpawn().spawn, powershell: spec !== undefined });
	const startupPolicy = policy();

	registerShellTool(pi, {
		name: "powershell",
		ccLabel: "PowerShell",
		description: text.powershellDescription({ edition: powerShellEdition(spec) }),
		parameters: powerShellParams(text.powershellParams),
		base,
		// The guideline joins the system prompt's tool guidelines at registration
		// (before the first request), so it is part of the cached prefix, never a
		// mid-session rebuild. Claude Code names PowerShell the primary shell when
		// the tool is on (2.1.126).
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			...(startupPolicy.primary === "powershell"
				? [text.powershellPrimary]
				: []),
		],
		foreground: perCwd((cwd: string) => createPowerShellToolDefinition(cwd, { operations })),
		guard: powershellGuardReason,
		words: () => shellResultText(view.live),
		backgroundShell: () => spec,
		// The foreground path prepends the tool's prefix inside the operations; the background spawn needs it too.
		wrapBackgroundCommand: (command) => `${POWERSHELL_TOOL_PREFIX}${command}`,
	});

	let noticesShown = false;
	const reconcile = (ctx?: Pick<ExtensionContext, "hasUI" | "ui">) => {
		const current = policy();
		const active = pi.getActiveTools();
		const next = withShellTools(active, current);
		if (next.join(" ") !== active.join(" ")) pi.setActiveTools(next);
		if (!announce || noticesShown || current.notices.length === 0) return;
		noticesShown = true;
		for (const notice of current.notices) {
			if (ctx?.hasUI) ctx.ui.notify(notice, "warning");
			else process.stderr.write(`${notice}\n`);
		}
	};

	pi.on("session_start", (_event, ctx) => reconcile(ctx));
	pi.on("model_select", () => reconcile());
	// pi restores the selected branch's tool loadout at a /tree switch.
	pi.on("session_tree", () => reconcile());
}

export default feature("powershell", powershellExtension);
