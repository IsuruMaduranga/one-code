/**
 * Deterministic pre-execution guards for the powershell tool (pure) — the
 * PowerShell spelling of `lib/shell/bash-guards.ts`'s wait and interactive guards, on
 * the same shared `leadingSleepReason` core. Steering, not security: the
 * permission gate and the auto-mode classifier still judge everything that
 * passes. A guard concludes only on a positive parse, so an unparseable line
 * always passes through.
 *
 * - wait guard (foreground): a line that LEADS with `Start-Sleep` (or its
 *   `sleep` alias) exists only to wait and stalls the session; a provably
 *   short sleep (< 2 s) is pacing and passes.
 * - interactive guard (foreground + background): `Read-Host`, `Get-Credential`,
 *   `Out-GridView`, `pause` and interactive git open a prompt this
 *   -NonInteractive shell answers with EOF or an error — the tool description
 *   already forbids them; the guard makes the refusal instructive.
 */

import { leadingSleepReason } from "../lib/shell/bash-guards.ts";
import { shellWords } from "../lib/shell-words.ts";
import { gitSubcommand } from "../lib/shell/shell-analysis.ts";
import { powershellStatements, statementCommand } from "../lib/shell/powershell-rules.ts";

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
			return shellWords().blocked({ kind: "consolePrompt", command: cmd });
		}
		if (cmd === "git") {
			// `gitSubcommand` skips git's value-taking global flags (`-C <dir>`,
			// `--git-dir <dir>`, `-c <key=val>`, …) so `git -C X rebase -i` still
			// finds "rebase" instead of misreading the flag's value as the
			// subcommand and missing the interactive-editor guard entirely.
			const words = statement.trim().split(/\s+/).slice(1);
			const { sub, rest } = gitSubcommand(words.map((value) => ({ value })));
			const flags = new Set(rest.map((t) => t.value));
			if (sub === "rebase" && (flags.has("-i") || flags.has("--interactive"))) {
				return shellWords().blocked({ kind: "rebaseInteractive", shell: "powershell" });
			}
			if (sub === "add" && ["-i", "--interactive", "-p", "--patch"].some((f) => flags.has(f))) {
				return shellWords().blocked({ kind: "addInteractive" });
			}
		}
	}
	if (opts.background) return undefined;

	return leadingSleepReason(
		statements,
		(statement) => (statementCommand(statement) === "start-sleep" ? startSleepSeconds(statement) : null),
		(statement) => statement,
		{ sleepName: "Start-Sleep", joiner: "; ", untilExample: "while (-not (<check>)) { Start-Sleep 2 }" },
	);
}
