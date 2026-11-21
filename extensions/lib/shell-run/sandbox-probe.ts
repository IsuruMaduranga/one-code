/**
 * Whether the Linux sandbox can run a command at all.
 *
 * The runtime's dependency check passes when bubblewrap and socat are
 * installed. On a kernel that restricts unprivileged user namespaces (the
 * default on Ubuntu 24.04 and later) bubblewrap is there and still cannot
 * build its namespace, so every sandboxed command would fail with an error
 * that names neither the sandbox nor the fix. One trivial command at start
 * tells, and the sandbox is then reported as not running, with the fix.
 */

import { readFileSync } from "node:fs";
import { detachedSpawnOptions, killProcessTree, waitForChildExit } from "./process-tree.ts";
import { type ShellSpawn, spawnShellCommand } from "./shell-spawn.ts";

/** The longest the trial command may take. */
const PROBE_TIMEOUT_MS = 15_000;

/** The kernel switch Ubuntu 24.04 turned on; "1" strips a new user namespace of its capabilities. */
const USERNS_SWITCH = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const USERNS_SYSCTL = "kernel.apparmor_restrict_unprivileged_userns";

/** Whether this kernel restricts unprivileged user namespaces. False where the switch does not exist. */
export function usernsRestricted(read: (path: string) => string = (path) => readFileSync(path, "utf8")): boolean {
	try {
		return read(USERNS_SWITCH).trim() === "1";
	} catch {
		return false;
	}
}

/** The fix for a restricted kernel, for the start warning and `/doctor`. */
export const USERNS_FIX = `run "sudo sysctl -w ${USERNS_SYSCTL}=0" (add it to /etc/sysctl.d to keep it), or add an AppArmor profile that grants userns to bwrap`;

/** Why the trial command failed, in words that name the fix when the kernel's restriction is the likely cause (pure). */
export function sandboxProbeFailure(stderr: string, restricted: boolean): string {
	const line = stderr.split("\n").map((entry) => entry.trim()).find((entry) => entry !== "") ?? "no error output";
	const cause = `bubblewrap could not run a command (${line})`;
	return restricted ? `${cause}. This kernel restricts unprivileged user namespaces, the default on Ubuntu 24.04 and later: ${USERNS_FIX}` : cause;
}

/**
 * Run `true` inside the sandbox. Returns why it failed, or undefined when it
 * ran. `wrap` is the runtime's wrapper; `shell` runs the wrapped line.
 */
export async function probeSandbox(wrap: (command: string) => Promise<string>, shell: ShellSpawn): Promise<string | undefined> {
	const child = spawnShellCommand(shell, await wrap("true"), { ...detachedSpawnOptions(), stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < 4000) stderr += chunk.toString();
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killProcessTree(child, "SIGKILL");
	}, PROBE_TIMEOUT_MS);
	try {
		const { code } = await waitForChildExit(child);
		if (code === 0 && !timedOut) return undefined;
		return sandboxProbeFailure(timedOut ? `no answer within ${PROBE_TIMEOUT_MS / 1000} seconds` : stderr, usernsRestricted());
	} catch (error) {
		return sandboxProbeFailure((error as Error).message, usernsRestricted());
	} finally {
		clearTimeout(timer);
	}
}
