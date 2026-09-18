/**
 * Deterministic pre-execution guards for the powershell tool (pure) — the
 * PowerShell spelling of `bash/guards.ts`'s wait and interactive guards.
 * Steering, not security: the permission gate and the auto-mode classifier
 * still judge everything that passes. A guard concludes only on a positive
 * parse, so an unparseable line always passes through.
 *
 * - wait guard (foreground): a line that LEADS with `Start-Sleep` (or its
 *   `sleep` alias) exists only to wait and stalls the session; a provably
 *   short sleep (< 2 s) is pacing and passes.
 * - interactive guard (foreground + background): `Read-Host`, `Get-Credential`,
 *   `Out-GridView`, `pause` and interactive git open a prompt this
 *   -NonInteractive shell answers with EOF or an error — the tool description
 *   already forbids them; the guard makes the refusal instructive.
 */

import { powershellStatements, statementCommand } from "../permissions/powershell-rules.ts";

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Seconds a `Start-Sleep` statement provably lasts, or undefined when its argument is not a literal. */
export function startSleepSeconds(statement: string): number | undefined {
	const tokens = statement.trim().split(/\s+/).slice(1);
	if (tokens.length === 0) return undefined;
	let unit: "s" | "ms" = "s";
	let value: number | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const named = /^-(s|sec|seconds|ms|milliseconds)(?::(.+))?$/i.exec(token);
		if (named) {
			unit = named[1].toLowerCase().startsWith("m") ? "ms" : "s";
			const inline = named[2] ?? tokens[++i];
			if (inline === undefined) return undefined;
			if (!/^\d+(\.\d+)?$/.test(inline)) return undefined;
			value = Number(inline);
			continue;
		}
		if (/^-d(uration)?$/i.test(token)) return undefined; // a TimeSpan literal — not modelled
		if (!/^\d+(\.\d+)?$/.test(token)) return undefined;
		value = Number(token);
	}
	if (value === undefined) return undefined;
	return unit === "ms" ? value / 1000 : value;
}

const INTERACTIVE = new Set(["read-host", "get-credential", "out-gridview", "pause"]);

export function powershellGuardReason(command: string, opts: { background: boolean }): string | undefined {
	const statements = powershellStatements(command);
	if (!statements || statements.length === 0) return undefined;

	for (const statement of statements) {
		const cmd = statementCommand(statement);
		if (INTERACTIVE.has(cmd)) {
			return (
				`Blocked: \`${cmd}\` waits on a console or GUI prompt, and this shell runs -NonInteractive with stdin on the null device — it would error or hang until the timeout. ` +
				"Ask the user with ask_user_question instead, or pass the value on the command line."
			);
		}
		if (cmd === "git") {
			const words = statement.trim().split(/\s+/).slice(1);
			const sub = words.find((w) => !w.startsWith("-"));
			const flags = new Set(words);
			if (sub === "rebase" && (flags.has("-i") || flags.has("--interactive"))) {
				return (
					"Blocked: `git rebase -i` opens an interactive editor, which this shell cannot provide — it would hang until the timeout. " +
					"Drive it non-interactively instead: `$env:GIT_SEQUENCE_EDITOR = ':'; git rebase …` accepts the todo list as-is, or restructure history with `git rebase --onto`, `git commit --amend`, or `git cherry-pick`."
				);
			}
			if (sub === "add" && ["-i", "--interactive", "-p", "--patch"].some((f) => flags.has(f))) {
				return (
					"Blocked: interactive `git add` prompts on a TTY this shell does not have — it would read EOF and stage nothing while appearing to succeed. " +
					"Stage whole files with `git add <paths>`, or stage a partial change non-interactively with `git apply --cached` and a crafted diff."
				);
			}
		}
	}
	if (opts.background) return undefined;

	// Wait guard: the run of LEADING Start-Sleep statements.
	let leadSleeps = 0;
	let total: number | undefined = 0;
	for (const statement of statements) {
		if (statementCommand(statement) !== "start-sleep") break;
		leadSleeps++;
		const seconds = startSleepSeconds(statement);
		total = total === undefined || seconds === undefined ? undefined : total + seconds;
	}
	if (leadSleeps === 0) return undefined;
	if (leadSleeps === 1 && total !== undefined && total < 2) return undefined;
	const rest = statements.slice(leadSleeps).join("; ");
	const shown = statements.slice(0, leadSleeps).join("; ");
	const echo = rest ? `\`${shown}\` followed by: ${clip(rest)}` : `standalone \`${shown}\``;
	return (
		`Blocked: ${echo}. A foreground Start-Sleep stalls the whole session while it runs. ` +
		"To wait for a command you started, run it with run_in_background: true — its completion arrives as a system notification on its own, so you never need to poll. " +
		"To wait for a condition, use the monitor tool with an until-loop (deferred — load it with tool_search select:monitor). " +
		"If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds. " +
		"Do not chain shorter sleeps to work around this block."
	);
}
