/**
 * Deterministic pre-execution guards for the bash tool (pure).
 *
 * Each guard recognises a workflow anti-pattern BEFORE the command runs and
 * refuses it with an instructive error: what tripped it, why it is a problem,
 * the sanctioned alternative, and a clause closing the obvious workaround.
 * These are steering, not security — the permission gate and the auto-mode
 * classifier still apply to everything that passes. The contract mirrors the
 * auto-mode pre-gate's: a guard concludes only on a positive parse, so an
 * unparseable command always passes through.
 *
 * Guards, in order:
 * - interactive guard (foreground + background): a command that needs a TTY
 *   (`vim`, `git rebase -i`, `git add -p`, `watch`) hangs until the timeout —
 *   or worse, silently no-ops — in this pipe-connected shell.
 * - wait guard (foreground): a command that LEADS with `sleep` exists only to
 *   wait and stalls the whole session. Provably-short sleeps (< 2s) are
 *   legitimate pacing and pass; a sleep deeper in a chain is a pause inside
 *   real work and is left alone.
 * - poll-loop guard (foreground): a `while`/`until`/`for` loop that sleeps is
 *   the same stall spelled as a loop — the monitor tool exists to run the
 *   until-loop without occupying the session.
 * - orphan guard (foreground): `nohup`/`setsid`/a top-level `&` detaches a
 *   process nothing manages, losing its output and exit status. A command
 *   that ends with `wait` reaps its own children and passes.
 */

import { gitSubcommand, leadTokens, parseCommand, resolvePayload, type Segment } from "../auto-mode/shell-analysis.ts";

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function bashGuardReason(command: string, opts: { background: boolean }): string | undefined {
	const { segments, parseFailed } = parseCommand(command);
	if (parseFailed || segments.length === 0) return undefined;
	const interactive = interactiveReason(segments);
	if (interactive || opts.background) return interactive;
	return waitReason(segments) ?? pollLoopReason(command, segments) ?? orphanReason(command, segments);
}

// ---------------------------------------------------------------------------
// Wait guard

/** Seconds a `sleep` argument provably represents, or undefined if not literal. */
function sleepSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(value);
	if (!match) return undefined;
	const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
	return Number(match[1]) * (mult ?? 1);
}

function waitReason(segments: Segment[]): string | undefined {
	const { command: cmd, args } = resolvePayload(leadTokens(segments[0]));
	if (cmd !== "sleep") return undefined;
	// A provably short sleep is legitimate pacing; an unprovable one (`sleep
	// "$DELAY"`) is treated as a wait — the model controls the literal.
	const seconds = sleepSeconds(args[0]?.value);
	if (seconds !== undefined && seconds < 2) return undefined;
	// A segment's raw slice can keep half of the operator that ended the previous
	// one (`a && b` → second raw is `& b`) — strip it for a clean echo.
	const rest = segments
		.slice(1)
		.map((s) => s.raw.replace(/^[;&|]+\s*/, ""))
		.filter(Boolean)
		.join("; ");
	const echo = rest ? `\`${segments[0].raw}\` followed by: ${clip(rest)}` : `standalone \`${segments[0].raw}\``;
	return (
		`Blocked: ${echo}. A foreground sleep stalls the whole session while it runs. ` +
		"To wait for a command you started, run it with run_in_background: true — its completion arrives as a system notification on its own, so you never need to poll. " +
		"To wait for a condition, use the monitor tool with an until-loop (e.g. `until <check>; do sleep 2; done`). " +
		"If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds. " +
		"Do not chain shorter sleeps to work around this block."
	);
}

// ---------------------------------------------------------------------------
// Poll-loop guard

function pollLoopReason(command: string, segments: Segment[]): string | undefined {
	const first = leadTokens(segments[0])[0]?.value;
	if (first !== "while" && first !== "until" && first !== "for") return undefined;
	// `sleep` counts only in command position (segment lead, or right after a
	// `do`/`then`/`else` keyword) — `echo sleep` is data, not a wait.
	const sleeps = segments.some((seg) => {
		const { command: cmd } = resolvePayload(leadTokens(seg));
		return cmd === "sleep";
	});
	if (!sleeps) return undefined;
	return (
		`Blocked: a foreground polling loop (\`${clip(command, 160)}\`). It occupies the whole session while it spins. ` +
		"Use the monitor tool to run the until-loop for you — it returns when the condition holds — or start the underlying work with run_in_background: true and let its completion notification arrive on its own. " +
		"Do not shorten the sleep or unroll the loop to work around this block."
	);
}

// ---------------------------------------------------------------------------
// Orphan guard

/** True when the command backgrounds something with a top-level unquoted `&`. */
export function hasBackgroundAmp(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			escape = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble || ch !== "&") continue;
		const prev = command[i - 1];
		const next = command[i + 1];
		if (next === "&") {
			i++; // logical &&
			continue;
		}
		if (next === ">") continue; // &> redirect
		if (prev === ">" || prev === "|") continue; // 2>&1 fd duplication, |& pipe
		return true;
	}
	return false;
}

function orphanReason(command: string, segments: Segment[]): string | undefined {
	const message = (via: string) =>
		`Blocked: this command detaches a process with ${via}, leaving an orphan this session cannot manage — its output and exit status would be lost. ` +
		"Run it with run_in_background: true instead: it returns a task id immediately, completion arrives as a system notification, output stays readable with task_output, and it can be stopped with task_stop. " +
		"If you need shell-level parallelism inside one command, end it with `wait` so the children are reaped.";

	let sawWait = false;
	for (const seg of segments) {
		const { command: cmd, peeled } = resolvePayload(leadTokens(seg));
		const detacher = peeled.find((p) => p === "nohup" || p === "setsid");
		if (detacher) return message(`\`${detacher}\``);
		if (cmd === "wait") sawWait = true;
	}
	// A heredoc body may contain literal `&`s the scanner cannot tell from a
	// top-level one — pass rather than misfire (contract: positive parse only).
	if (/<</.test(command)) return undefined;
	if (hasBackgroundAmp(command) && !sawWait) return message("`&`");
	return undefined;
}

// ---------------------------------------------------------------------------
// Interactive guard

const EDITORS = new Set(["vi", "vim", "nvim", "view", "vimdiff", "nano", "pico", "emacs"]);

function interactiveReason(segments: Segment[]): string | undefined {
	for (const seg of segments) {
		const { command: cmd, args } = resolvePayload(leadTokens(seg));
		if (EDITORS.has(cmd)) {
			if (cmd === "emacs" && args.some((a) => ["--batch", "-batch", "--script"].includes(a.value))) continue;
			return (
				`Blocked: \`${cmd}\` is an interactive editor and this shell has no TTY — it would hang until the timeout. ` +
				"Read files with the read tool and change them with edit/write."
			);
		}
		if (cmd === "watch") {
			return (
				"Blocked: `watch` needs an interactive terminal, which this shell does not have. " +
				"Use the monitor tool to wait for a condition (it runs an until-loop and returns when the condition holds), or run_in_background: true with task_output to check on long-running output."
			);
		}
		if (cmd !== "git") continue;
		const { sub, rest } = gitSubcommand(args);
		const flags = new Set(rest.map((t) => t.value));
		if (sub === "rebase" && (flags.has("-i") || flags.has("--interactive"))) {
			return (
				"Blocked: `git rebase -i` opens an interactive editor, which this shell cannot provide — it would hang until the timeout. " +
				"Drive it non-interactively instead: `GIT_SEQUENCE_EDITOR=: git rebase …` accepts the todo list as-is, or restructure history with `git rebase --onto`, `git commit --amend`, or `git cherry-pick`."
			);
		}
		if (sub === "add" && ["-i", "--interactive", "-p", "--patch"].some((f) => flags.has(f))) {
			return (
				"Blocked: interactive `git add` prompts on a TTY this shell does not have — it would read EOF and stage nothing while appearing to succeed. " +
				"Stage whole files with `git add <paths>`, or stage a partial change non-interactively with `git apply --cached` and a crafted diff."
			);
		}
	}
	return undefined;
}
