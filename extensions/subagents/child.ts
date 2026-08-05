/**
 * Child-process subagent runner: spawns `pi --mode json -p`, parses its JSONL
 * event stream, and exposes a handle usable both foreground (await result)
 * and background (kill/snapshot, registered as a background task).
 *
 * Children persist their sessions (`--session-dir` per run) so a finished
 * agent can be resumed later via `--session <file>` — that is what
 * send_message builds on. `--no-session` is only the fallback when the parent
 * itself has no session directory.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import type { AgentDefinition } from "./agents.ts";
import { addUsage, emptyUsage, type UsageTotals } from "./usage.ts";

export const OUTPUT_CAP = 50_000;

export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export interface ChildOptions {
	agent?: AgentDefinition;
	task: string;
	cwd: string;
	/** Parent session file, for fork runs. */
	forkFrom?: string;
	/** Existing child session to continue (send_message). */
	sessionFile?: string;
	/** Where a new run's session file lands; falls back to --no-session. */
	sessionDir?: string;
	model?: string;
	thinking?: string;
	signal?: AbortSignal;
	onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void;
}

export interface ChildOutcome {
	output: string;
	toolCalls: number;
	usage: UsageTotals;
	failed?: boolean;
}

export interface ChildHandle {
	result: Promise<ChildOutcome>;
	kill(): void;
	snapshot(): { toolCalls: number; text: string; usage: UsageTotals };
}

export function startChild(options: ChildOptions): ChildHandle {
	const { agent, task, cwd, forkFrom, sessionFile, sessionDir, signal, onProgress } = options;
	const args = ["--mode", "json", "-p"];

	if (sessionFile) {
		args.push("--session", sessionFile);
	} else if (forkFrom) {
		// pi forks the session file into a fresh session, so the child starts with
		// the parent's transcript and our own system prompt still applies.
		args.push("--fork", forkFrom);
		if (sessionDir) args.push("--session-dir", sessionDir);
	} else {
		if (sessionDir) args.push("--session-dir", sessionDir);
		else args.push("--no-session");
		if (agent) {
			const tmpDir = mkdtempSync(join(os.tmpdir(), "cc-subagent-"));
			const promptPath = join(tmpDir, "system.md");
			writeFileSync(promptPath, agent.systemPrompt);
			args.push("--system-prompt", promptPath);
		}
	}

	const model = options.model ?? agent?.model;
	if (model) args.push("--model", model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (agent?.tools && !forkFrom && !sessionFile) args.push("--tools", agent.tools.join(","));
	args.push(task);

	const invocation = piInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
	});

	let buffer = "";
	let finalText = "";
	let toolCalls = 0;
	let stderr = "";
	const usage = emptyUsage();

	const onAbort = () => child.kill("SIGTERM");
	signal?.addEventListener("abort", onAbort, { once: true });

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: { type?: string; message?: { role?: string; content?: unknown; usage?: unknown } };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "tool_execution_start") {
			toolCalls++;
			onProgress(toolCalls, finalText, usage);
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			addUsage(usage, event.message.usage);
			const blocks = Array.isArray(event.message.content) ? event.message.content : [];
			const text = blocks
				.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
				.map((b) => b.text)
				.join("");
			if (text.trim()) finalText = text;
			onProgress(toolCalls, finalText, usage);
		}
	};

	const result = new Promise<ChildOutcome>((resolve) => {
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let idx: number;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				processLine(buffer.slice(0, idx));
				buffer = buffer.slice(idx + 1);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ output: `Failed to start subagent: ${error.message}`, toolCalls, usage, failed: true });
		});

		child.on("close", (code, closeSignal) => {
			signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			const output = finalText.slice(0, OUTPUT_CAP);
			if (output.trim()) {
				resolve({ output, toolCalls, usage });
				return;
			}
			const why = closeSignal ? `terminated by ${closeSignal}` : `exit code ${code}`;
			const detail = stderr.trim().split("\n").slice(-5).join("\n");
			resolve({
				output: `Subagent produced no output (${why}).${detail ? `\n${detail}` : ""}`,
				toolCalls,
				usage,
				failed: true,
			});
		});
	});

	return {
		result,
		kill: () => child.kill("SIGTERM"),
		snapshot: () => ({ toolCalls, text: finalText, usage }),
	};
}
