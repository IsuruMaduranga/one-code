/**
 * The words of the shell sandbox (the profile's `text.shell.sandbox`): Claude
 * Code 2.1.329's "Bash command sandbox" section, with One Code's
 * corrections. Left out: the per-command `allowed_domains` list and the
 * `.git/worktrees` rule, which this sandbox does not have. The strict
 * variant and the unavailable notes are One Code's own.
 */

import type { ShellSandboxText } from "../../../extensions/sdk/profile.ts";

const MECHANISM = { darwin: "macOS Seatbelt", linux: "bubblewrap" } as const;

const BOUNDARY =
	"The sandbox marks out what this session was given: the directories listed below, the network destinations the task involves, and the credentials the user supplied for it. Treat that as the boundary even where a limit below is not enforced. Commands can reach more than that — credentials and keys elsewhere on this machine, the user's other projects and configuration, sockets that control this machine or other workloads, cloud metadata endpoints — but being reachable does not make them provided; those are the user's, not the task's, unless the user's request calls for them. If the task cannot be finished with what you were given, do what you can and tell the user plainly what is missing instead of finding another way to it; that report is a complete answer.";

/** The model may ask to leave the sandbox. */
const RETRY_RULES = [
	" - You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:\n  - The user *explicitly* asks you to bypass sandbox\n  - A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).",
	" - Evidence of sandbox-caused failures includes:\n  - \"Operation not permitted\" errors for file/network operations\n  - Access denied to specific paths outside allowed directories\n  - Network connection failures to non-whitelisted hosts\n  - Unix socket connection errors",
	" - When you see evidence of sandbox-caused failure:\n  - Retry with `dangerouslyDisableSandbox: true` directly rather than asking in prose first — the retry itself goes through the permission gate (a user prompt, or the auto-mode classifier when auto mode is active)\n  - Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.",
	" - A sandbox denial on a credential, a file or a host that the task does not involve is the boundary above at work: tell the user rather than retrying with `dangerouslyDisableSandbox: true`.",
	" - Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.",
];

/** `allowUnsandboxedCommands` is off: every command stays in the sandbox. */
const STRICT_RULES = [
	" - Every command runs within the sandbox in this session: `dangerouslyDisableSandbox` is ignored. Commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).",
	" - Evidence of sandbox-caused failures includes:\n  - \"Operation not permitted\" errors for file/network operations\n  - Access denied to specific paths outside allowed directories\n  - Network connection failures to non-whitelisted hosts\n  - Unix socket connection errors",
	" - When you see evidence of sandbox-caused failure, briefly explain what sandbox restriction likely caused it and tell the user: they can change the sandbox settings (the `/sandbox` command shows them) or run the command themselves.",
];

const COMMON_RULES = [
	" - Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.",
	" - Network egress goes through a filtering proxy. Attempt requests and read the error rather than predicting whether a host is reachable; denied connections are reported in a `<sandbox_violations>` block explaining the reason. A denied host is one the user's `sandbox.network.allowedDomains` setting does not list.",
	" - If a command fails to bind or listen on a local port with \"Operation not permitted\" (EPERM), local port binding is off in this sandbox. Treat it as the sandbox-caused failure described above, and tell the user that `sandbox.network.allowLocalBinding: true` in their settings (it applies without a restart) allows it without leaving the sandbox.",
];

const MACOS_RULES = [
	" - Opening an app, file or URL with `open`, or scripting another app with `osascript`, is blocked inside this sandbox (macOS Launch Services and Apple Events are off) and fails with errors such as -10822 (kLSServerCommunicationErr), -54, -600 or \"LSOpenURLsWithRole() failed\". That failure is the sandbox, not a problem with what you built; do not retry it with `dangerouslyDisableSandbox: true`. Tell the user the sandbox blocked it and give them the exact command to run themselves.",
	" - On macOS, a sandboxed command can look into and signal only the processes that it started itself, not those of an earlier command or of the user. `lsof` leaves the others out and prints no error, so an empty `lsof -i :3000` does not mean that the port is free, and `lsof -ti:3000 | xargs kill` can stop nothing and still exit 0. Libraries that ask the system themselves get a permission error (psutil: `AccessDenied`; elsewhere \"Operation not permitted\"). To find or stop such a process (a server that an earlier command left running, say), retry as described above for a sandbox-caused failure, and tell the user in the same message that the sandbox hides other processes and that the retry runs without its protection.",
];

const TMPDIR_RULE =
	" - For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.";

export const shellSandboxText: ShellSandboxText = {
	disableParam: "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
	section: ({ platform, filesystem, network, unsandboxedAllowed }) =>
		[
			"## Bash command sandbox",
			`By default, Bash commands run inside an OS-level sandbox (${MECHANISM[platform]}) applied to each command separately, not to the session as a whole; how it is configured in this session is described below.`,
			"",
			BOUNDARY,
			"",
			"How the sandbox is configured in this session:",
			`Filesystem: ${filesystem}`,
			`Network: ${network}`,
			"",
			...(unsandboxedAllowed ? RETRY_RULES : STRICT_RULES),
			...COMMON_RULES,
			...(platform === "darwin" ? MACOS_RULES : []),
			TMPDIR_RULE,
		].join("\n"),
	turnedOff: "The Bash command sandbox described earlier is off in this session now: commands run without it and `dangerouslyDisableSandbox` has no effect.",
	unavailable: ({ reason, required }) =>
		`## Bash command sandbox\nThe user's settings turn the Bash command sandbox on, but it could not start in this session (${reason}). ` +
		(required
			? "The settings require it, so Bash commands are refused until it can start. Tell the user what is missing; do not look for another way to run commands."
			: "Bash commands run without it. Tell the user once that the sandbox is off and why."),
	refused: (p) =>
		p.kind === "powershell"
			? "The command sandbox is on in this session and it runs Bash commands only, so this PowerShell command was not run. Use the bash tool."
			: `The sandbox is required by the user's settings (sandbox.failIfUnavailable) and is not running: ${p.reason}. The command was not run. Tell the user what is missing; they can fix it or change the sandbox settings.`,
};
