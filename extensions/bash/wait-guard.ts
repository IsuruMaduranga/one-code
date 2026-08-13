/**
 * Foreground-wait guard for the bash tool (pure).
 *
 * Claude Code blocks a foreground command whose only job is to *wait* — a
 * top-level `sleep` (alone, or leading a `sleep N && poll` / `sleep N; check`
 * chain) — and steers the model to the mechanisms built for waiting instead. We
 * mirror that: a foreground sleep stalls the whole session for nothing, and
 * chaining shorter sleeps to poll is exactly the anti-pattern the guard exists to
 * stop. One Code has the right alternatives already — `run_in_background: true`
 * (completion arrives as a notification, no polling), the monitor tool (watch a
 * condition), and schedule_wakeup.
 *
 * Only a command that LEADS with `sleep` is blocked: a brief `sleep` inside a
 * larger command (`build && sleep 2 && smoke-test`) is a legitimate pause and is
 * left alone, and a `sleep` inside a script file is invisible here anyway. The
 * guard applies to foreground calls only — `run_in_background: true` with a sleep
 * is the sanctioned way to wait and is never blocked.
 */

import { parseCommand } from "../auto-mode/shell-analysis.ts";

export const FOREGROUND_WAIT_MESSAGE =
	"Blocked: this is a foreground `sleep` used to wait, which stalls the whole session while it runs. " +
	"Do not wait with a foreground sleep, and do not chain shorter sleeps to get around this. Instead:\n" +
	"- run the work with run_in_background: true — its completion arrives as a system notification on its own, so you never have to poll;\n" +
	"- to wait for a specific condition, use the monitor tool with an until-loop, or schedule_wakeup to resume later.\n" +
	"(A brief sleep *inside* a larger command is fine — this blocks only a command that leads with `sleep`.)";

/**
 * The block reason if `command` is a foreground wait (its first top-level command
 * is `sleep`), else undefined. An unparseable command is let through — the
 * permission gate and classifier still apply to it.
 */
export function foregroundWaitReason(command: string): string | undefined {
	let segments;
	try {
		({ segments } = parseCommand(command));
	} catch {
		return undefined;
	}
	const lead = segments[0]?.tokens[0]?.value;
	return lead === "sleep" ? FOREGROUND_WAIT_MESSAGE : undefined;
}
