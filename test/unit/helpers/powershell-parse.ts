/**
 * PowerShell's own parse for tests of the PowerShell gate: one parse server
 * per test file on the local PowerShell (local-pwsh.ts), started lazily.
 * Tests that need it are wrapped in `describe.skipIf(!HAVE_POWERSHELL)`; CI
 * has pwsh on every runner.
 */
import { homedir } from "node:os";
import { type PowerShellParse, PowerShellParser } from "../../../extensions/lib/powershell-parser.ts";
import { spawnShellCommand, type ShellSpawn } from "../../../extensions/lib/shell-spawn.ts";
import { powershellReadOnly, type PowerShellReadOnlyOptions } from "../../../extensions/permissions/powershell-rules.ts";
import { localPwsh } from "./local-pwsh.ts";

export const LOCAL_POWERSHELL = localPwsh();
export const HAVE_POWERSHELL = LOCAL_POWERSHELL !== undefined;

/**
 * A parser on `spec`, with generous timeouts for a cold CI runner. The shared
 * one is never stopped: its server is unref'd and exits with the test worker.
 */
export function testParser(spec: ShellSpawn): PowerShellParser {
	return new PowerShellParser({
		spawnServer: (bootstrap) => spawnShellCommand(spec, bootstrap, { stdio: ["pipe", "pipe", "pipe"] }),
		startTimeoutMs: 60_000,
		requestTimeoutMs: 20_000,
	});
}

let shared: PowerShellParser | undefined;

/** PowerShell's parse of `command`; throws when the parser cannot answer. */
export async function psParse(command: string): Promise<PowerShellParse> {
	if (!LOCAL_POWERSHELL) throw new Error("no local PowerShell: wrap the test in describe.skipIf(!HAVE_POWERSHELL)");
	shared ??= testParser(LOCAL_POWERSHELL);
	const outcome = await shared.parse(command);
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.parse;
}

/** `powershellReadOnly` on PowerShell's parse of `command`. */
export async function psReadOnly(command: string, opts: Omit<PowerShellReadOnlyOptions, "parse"> = { cwd: process.cwd(), home: homedir() }) {
	return powershellReadOnly({ ...opts, parse: await psParse(command) });
}

/** Aliases PowerShell defines on Windows only; on macOS and Linux these names run the native program. */
export const WINDOWS_ONLY_ALIAS = process.platform === "win32";
