/**
 * When the `powershell` tool is on, and which shell tool is primary (pure).
 *
 * Claude Code's gate (2.1.276 binary function `f0`, findings §22):
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL` wins wherever it is set — truthy turns the
 * tool on, `0`/`false` off. Unset: on Windows the tool is on (Git Bash absent
 * → on by necessity; Git Bash present → on, the claude.ai/Console default the
 * docs describe — plan §Open questions 1, resolved "on"); off Windows it is
 * off, so a Mac or Linux user opts in with the same variable Claude Code
 * uses. When it is on, PowerShell is the primary shell (CC 2.1.126) and bash
 * stays alongside when a bash exists. A Windows box with neither shell fails
 * loud at startup in Claude Code's words.
 */

export type PowerShellSwitch = "on" | "off" | "unset";

/** `CLAUDE_CODE_USE_POWERSHELL_TOOL` as Claude Code reads it: unset/empty → unset, `0`/`false`/`no`/`off` → off, anything else → on. */
export function powerShellSwitch(env: NodeJS.ProcessEnv): PowerShellSwitch {
	const raw = env.CLAUDE_CODE_USE_POWERSHELL_TOOL?.trim().toLowerCase();
	if (raw === undefined || raw === "") return "unset";
	return ["0", "false", "no", "off"].includes(raw) ? "off" : "on";
}

export interface ShellAvailability {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** A bash resolved (Git Bash on Windows, /bin/bash elsewhere). */
	bash: boolean;
	/** A PowerShell resolved (pwsh/powershell.exe on Windows, pwsh on PATH elsewhere). */
	powershell: boolean;
}

export type PrimaryShell = "powershell" | "bash" | "none";

export interface ShellToolPolicy {
	/** The `powershell` tool is active. */
	powershell: boolean;
	/** The `bash` tool is active. */
	bash: boolean;
	primary: PrimaryShell;
	/** Startup notices for the user (a set switch with no PowerShell; no shell at all). */
	notices: string[];
}

/** Claude Code's own wording for a Windows machine with no shell tool. */
export const NO_SHELL_NOTICE =
	"No shell available: install Git for Windows (https://git-scm.com/download/win) so the bash tool can run, " +
	"or install PowerShell and set CLAUDE_CODE_USE_POWERSHELL_TOOL=1.";

export function shellToolPolicy(a: ShellAvailability): ShellToolPolicy {
	const sw = powerShellSwitch(a.env);
	const wanted = sw === "on" ? true : sw === "off" ? false : a.platform === "win32";
	const powershell = wanted && a.powershell;
	const notices: string[] = [];
	if (sw === "on" && !a.powershell) {
		notices.push(
			a.platform === "win32"
				? "CLAUDE_CODE_USE_POWERSHELL_TOOL is set but no pwsh.exe or powershell.exe was found on PATH; the powershell tool stays off."
				: "CLAUDE_CODE_USE_POWERSHELL_TOOL is set but no `pwsh` was found on PATH; install PowerShell 7 to use the powershell tool.",
		);
	}
	const bash = a.bash;
	const primary: PrimaryShell = powershell ? "powershell" : bash ? "bash" : "none";
	if (primary === "none" && a.platform === "win32") notices.push(NO_SHELL_NOTICE);
	return { powershell, bash, primary, notices };
}

/**
 * The active-tool list adjusted for the policy: `powershell` appended when
 * on (pi never activates it on its own — a registered override of a built-in
 * name does not join the active set), removed when off; `bash` removed when
 * no bash exists (its executor would throw on every call). Existing order is
 * kept so the rebuilt system prompt stays byte-stable.
 */
export function withShellTools(active: string[], policy: Pick<ShellToolPolicy, "powershell" | "bash">): string[] {
	const next = active.filter((name) => (name === "powershell" ? policy.powershell : name === "bash" ? policy.bash : true));
	if (policy.powershell && !next.includes("powershell")) next.push("powershell");
	return next;
}
