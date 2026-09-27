/**
 * Expanding a plugin command body: arguments, then each `` !`command` ``
 * placeholder replaced with that command's output.
 *
 * Two rules keep a typed argument from becoming shell syntax. Placeholders
 * are found in the body as written, before any argument goes in, and an
 * argument substituted into a placeholder's command goes in as a
 * single-quoted word (`template.ts`), so `$(…)`, `;` or a backtick pair in
 * what the user typed stays text. And the command runs in the bash every
 * other shell path uses (`lib/shell-spawn.ts`: Git Bash on Windows, never a
 * bare `/bin/sh` or `cmd.exe`), as Claude Code runs these in its bash:
 * Node's `shell: true` used `/bin/sh` (dash on Debian and Ubuntu) and
 * `cmd.exe`, where `[[ ]]`, `head` and process substitution fail and the
 * error text became the placeholder's output.
 */

import type { ChildProcess } from "node:child_process";
import { detachedSpawnOptions, killProcessTree, waitForChildExit } from "../lib/process-tree.ts";
import { bashSpawn, type ShellSpawn, spawnShellCommand } from "../lib/shell-spawn.ts";
import { shellQuote } from "../lib/shell-quote.ts";
import { splitShellPlaceholders, substituteArguments } from "./template.ts";

export const SHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Run one placeholder command in bash and return its stdout (stderr when
 * stdout is empty), trimmed. A failure returns its error text, as before:
 * the placeholder shows what went wrong rather than vanishing.
 */
export async function runPlaceholderCommand(
	command: string,
	cwd: string,
	opts: { spec?: ShellSpawn; timeoutMs?: number } = {},
): Promise<string> {
	const spec = opts.spec ?? bashSpawn().spawn;
	if (!spec) return `command failed: ${bashSpawn().error ?? "no bash shell found"}`;
	let child: ChildProcess;
	try {
		child = spawnShellCommand(spec, command, { cwd, stdio: ["ignore", "pipe", "pipe"], ...detachedSpawnOptions() });
	} catch (error) {
		return `command failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	let stdout = "";
	let stderr = "";
	const capture = (sink: "stdout" | "stderr") => (chunk: string) => {
		const current = sink === "stdout" ? stdout : stderr;
		if (current.length >= MAX_OUTPUT_BYTES) return;
		const next = current + chunk.slice(0, MAX_OUTPUT_BYTES - current.length);
		if (sink === "stdout") stdout = next;
		else stderr = next;
	};
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", capture("stdout"));
	child.stderr?.on("data", capture("stderr"));
	let timedOut = false;
	const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
	const timer = setTimeout(() => {
		timedOut = true;
		killProcessTree(child, "SIGKILL");
	}, timeoutMs);
	timer.unref();
	try {
		await waitForChildExit(child);
	} catch (error) {
		return `command failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		clearTimeout(timer);
	}
	const text = (stdout || stderr).trim();
	if (timedOut) return `${text ? `${text}\n` : ""}command timed out after ${Math.round(timeoutMs / 1000)} seconds`;
	return text;
}

/**
 * Expand a command body: every placeholder's command runs once (with the
 * arguments quoted in), text pieces get the arguments as typed, and an
 * output is never scanned for arguments or placeholders again. `persist`
 * bounds each output (a large `git diff`) before it lands in the prompt.
 */
export async function expandTemplate(
	body: string,
	args: string,
	cwd: string,
	opts: { persist?: (text: string, index: number) => string; run?: (command: string, cwd: string) => Promise<string> } = {},
): Promise<string> {
	const pieces = splitShellPlaceholders(body);
	const commands = [...new Set(pieces.flatMap((piece) => (piece.kind === "shell" ? [substituteArguments(piece.command, args, shellQuote)] : [])))];
	const run = opts.run ?? ((command: string, dir: string) => runPlaceholderCommand(command, dir));
	const outputs = new Map<string, string>();
	await Promise.all(
		commands.map(async (command, index) => {
			const text = await run(command, cwd);
			outputs.set(command, opts.persist ? opts.persist(text, index) : text);
		}),
	);
	return pieces
		.map((piece) => (piece.kind === "text" ? substituteArguments(piece.text, args) : (outputs.get(substituteArguments(piece.command, args, shellQuote)) ?? "")))
		.join("");
}
