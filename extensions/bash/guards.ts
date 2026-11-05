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

import {
	gitSubcommand,
	leadTokens,
	LOOPS,
	parseCommand,
	resolvePayload,
	type Segment,
	type Token,
} from "../auto-mode/shell-analysis.ts";
import { shellWords } from "../lib/shell-words.ts";

export const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function bashGuardReason(command: string, opts: { background: boolean }): string | undefined {
	// A heredoc body is data to the grammar, so a literal `vim` or `while …
	// sleep` inside a document never trips a guard (review T14).
	const parsed = parseCommand(command);
	if (parsed.parseFailed || parsed.segments.length === 0) return undefined;
	const { segments } = parsed;
	const interactive = interactiveReason(segments);
	if (interactive || opts.background) return interactive;
	return waitReason(segments) ?? pollLoopReason(command, segments) ?? orphanReason(parsed.background, segments);
}

// ---------------------------------------------------------------------------
// Wait guard

/**
 * Seconds a `sleep` invocation provably lasts (GNU sleep sums multiple
 * duration arguments), or undefined when any argument is not a literal.
 */
function sleepSeconds(args: Token[]): number | undefined {
	if (args.length === 0) return undefined;
	let total = 0;
	for (const arg of args) {
		const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(arg.value);
		if (!match) return undefined;
		total += Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]] ?? 1);
	}
	return total;
}

// A segment's raw slice can keep half of the operator that ended the previous
// one (`a && b` → second raw is `& b`) — strip it for a clean echo.

/**
 * The wait guard's grammar-independent half, shared with the PowerShell
 * guards: measure the run of LEADING sleep statements — `sleep 1 && sleep 1 &&
 * …` is one wait spelled as a chain, so the pacing exemption applies only to a
 * single provably-short sleep. Unprovable durations (`sleep "$DELAY"`) count
 * as long: the model controls the literal. `sleepSeconds` returns undefined
 * for a non-sleep statement.
 */
export function leadingSleepReason<T>(
	statements: T[],
	sleepSeconds: (statement: T) => number | undefined | null,
	raw: (statement: T) => string,
	opts: { sleepName: string; joiner: string; untilExample: string },
): string | undefined {
	let leadSleeps = 0;
	let total: number | undefined = 0;
	for (const statement of statements) {
		const seconds = sleepSeconds(statement);
		if (seconds === null) break; // not a sleep
		leadSleeps++;
		total = total === undefined || seconds === undefined ? undefined : total + seconds;
	}
	if (leadSleeps === 0) return undefined;
	if (leadSleeps === 1 && total !== undefined && total < 2) return undefined;
	const rest = statements.slice(leadSleeps).map(raw).filter(Boolean).join("; ");
	const shown = statements.slice(0, leadSleeps).map(raw).join(opts.joiner);
	return shellWords().blocked({ kind: "sleep", shown, ...(rest ? { rest: clip(rest) } : {}), sleepName: opts.sleepName, untilExample: opts.untilExample });
}

function waitReason(segments: Segment[]): string | undefined {
	return leadingSleepReason(
		segments,
		(seg) => {
			const { command: cmd, args } = resolvePayload(leadTokens(seg));
			return cmd === "sleep" ? sleepSeconds(args) : null;
		},
		(seg) => seg.raw,
		{ sleepName: "sleep", joiner: " && ", untilExample: "until <check>; do sleep 2; done" },
	);
}

// ---------------------------------------------------------------------------
// Poll-loop guard

const inLoop = (seg: Segment) => seg.enclosing.some((construct) => LOOPS.has(construct));

function pollLoopReason(command: string, segments: Segment[]): string | undefined {
	// Wherever the loop sits in the line: `echo start; while true; do sleep 5;
	// done` stalls the session as surely as the loop alone. `sleep` counts only
	// as a command inside the loop: `echo sleep` is data.
	const sleeps = segments.some((seg) => inLoop(seg) && resolvePayload(leadTokens(seg)).command === "sleep");
	if (!sleeps) return undefined;
	return shellWords().blocked({ kind: "pollingLoop", command: clip(command, 160) });
}

// ---------------------------------------------------------------------------
// Orphan guard

function orphanReason(background: boolean, segments: Segment[]): string | undefined {
	const message = (via: string) => shellWords().blocked({ kind: "detach", via });

	for (const seg of segments) {
		const { peeled } = resolvePayload(leadTokens(seg));
		const detacher = peeled.find((p) => p === "nohup" || p === "setsid");
		if (detacher) return message(`\`${detacher}\``);
	}
	// Only a `wait` that comes LAST reaps the children — `wait; job &` still
	// orphans the job it precedes.
	const lastCmd = resolvePayload(leadTokens(segments[segments.length - 1])).command;
	if (background && lastCmd !== "wait") return message("`&`");
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
			return shellWords().blocked({ kind: "editor", command: cmd });
		}
		if (cmd === "watch") {
			return shellWords().blocked({ kind: "watch" });
		}
		if (cmd !== "git") continue;
		const { sub, rest } = gitSubcommand(args);
		const flags = new Set(rest.map((t) => t.value));
		if (sub === "rebase" && (flags.has("-i") || flags.has("--interactive"))) {
			return shellWords().blocked({ kind: "rebaseInteractive", shell: "bash" });
		}
		if (sub === "add" && ["-i", "--interactive", "-p", "--patch"].some((f) => flags.has(f))) {
			return shellWords().blocked({ kind: "addInteractive" });
		}
	}
	return undefined;
}
