/**
 * A PowerShell to run live tests against: pwsh on PATH, else the
 * cc-windows-mode skill's portable copy on this Mac; and, on Windows, the
 * built-in Windows PowerShell 5.1. Tests skip cleanly where none exists.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { POWERSHELL_ARGS, resolvePowerShellSpawn, type ShellSpawn } from "../../../extensions/lib/shell-spawn.ts";

export const PORTABLE_PWSH_DIR = join(homedir(), ".cache", "cc-windows-mode", "pwsh");

export function localPwsh(): ShellSpawn | undefined {
	const onPath = resolvePowerShellSpawn();
	if (onPath) return onPath;
	const portable = join(PORTABLE_PWSH_DIR, "pwsh");
	return existsSync(portable) ? { shell: portable, args: [...POWERSHELL_ARGS] } : undefined;
}

/** Windows PowerShell 5.1 (`powershell.exe`), present on every Windows install; undefined elsewhere. */
export function windowsPowerShell(): ShellSpawn | undefined {
	if (process.platform !== "win32") return undefined;
	const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(exe) ? { shell: exe, args: [...POWERSHELL_ARGS] } : undefined;
}
