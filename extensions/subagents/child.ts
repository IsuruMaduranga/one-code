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
import { type ChildAction, recordAction } from "../auto-mode/actions.ts";
import type { AgentDefinition } from "./agents.ts";
import { RpcTurnTracker, toMainMessage } from "./rpc-turns.ts";
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

/**
 * Framing wrapped around a fork child's task. A fork inherits the parent's
 * entire transcript; without this, a weaker model tends to abandon its
 * assigned task and continue (or confabulate about) the inherited topic —
 * then its output returns to the parent looking like independent
 * confirmation. See docs/handoff-tool-ambiguity.md (fork confabulation).
 */
export function forkTaskMessage(task: string): string {
	return [
		"You are a forked subagent. The conversation above is inherited context, for reference only — do NOT continue its open threads, verify its claims, or act on its plans. Do ONLY the task below; your final message is returned to the parent conversation verbatim, as data. You cannot see the parent's background tasks: its task ids are not addressable from here.",
		"",
		"Task:",
		task,
	].join("\n");
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
	/** The child called send_message {to: "main"} — relay it to the main conversation. */
	onMessageToMain?: (message: string, summary?: string) => void;
}

/** Session/agent/model flags shared by print and rpc children. */
function buildChildFlags(options: Omit<ChildOptions, "task" | "signal" | "onProgress">): string[] {
	const { agent, forkFrom, sessionFile, sessionDir } = options;
	const args: string[] = [];

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
	return args;
}

export interface ChildOutcome {
	output: string;
	toolCalls: number;
	usage: UsageTotals;
	failed?: boolean;
	/**
	 * What the child actually did, names and short subjects only. Auto mode
	 * reviews this when the child returns, to catch a sequence whose individual
	 * steps each passed. Never carries tool output — see auto-mode/actions.ts.
	 */
	actions: ChildAction[];
}

/**
 * A provider failure in a child (auth, billing, rate limit) surfaces ONLY as
 * an assistant message with stopReason "error" in the event stream — stderr
 * stays empty and the process exits normally. Without capturing it, the
 * parent gets "Subagent produced no output (exit code 0)", the exact
 * ambiguous result a weak model confabulates a cause for. The error is
 * cleared by any later successful assistant message, so pi's internal
 * retries don't leave a stale failure.
 */
export function providerErrorFrom(message: { stopReason?: string; errorMessage?: string } | undefined): string | undefined {
	if (!message) return undefined;
	if (message.stopReason !== "error") return undefined;
	return message.errorMessage || "unknown provider error";
}

/** The outcome a finished child resolves to, given everything its stream said. */
export function closeOutcome(args: {
	finalText: string;
	providerError?: string;
	code: number | null;
	closeSignal: NodeJS.Signals | null;
	stderr: string;
	toolCalls: number;
	usage: UsageTotals;
	actions: ChildAction[];
}): ChildOutcome {
	const { finalText, providerError, code, closeSignal, stderr, toolCalls, usage, actions } = args;
	const output = finalText.slice(0, OUTPUT_CAP);
	if (providerError) {
		return {
			output: output.trim()
				? `${output}\n\n[The subagent's last request ended with a provider error: ${providerError}]`
				: `Subagent failed with a provider error (its model could not be called — an auth/billing/rate-limit problem, not a task failure): ${providerError}`,
			toolCalls,
			usage,
			actions,
			failed: true,
		};
	}
	if (output.trim()) {
		return { output, toolCalls, usage, actions };
	}
	const why = closeSignal ? `terminated by ${closeSignal}` : `exit code ${code}`;
	const detail = stderr.trim().split("\n").slice(-5).join("\n");
	return {
		output: `Subagent produced no output (${why}).${detail ? `\n${detail}` : ""}`,
		toolCalls,
		usage,
		actions,
		failed: true,
	};
}

export interface ChildHandle {
	result: Promise<ChildOutcome>;
	kill(): void;
	snapshot(): { toolCalls: number; text: string; usage: UsageTotals };
}

export function startChild(options: ChildOptions): ChildHandle {
	const { cwd, signal, onProgress } = options;
	const task = options.forkFrom ? forkTaskMessage(options.task) : options.task;
	const args = ["--mode", "json", "-p", ...buildChildFlags(options), task];

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
	const actions: ChildAction[] = [];
	let stderr = "";
	let providerError: string | undefined;
	const usage = emptyUsage();

	const onAbort = () => child.kill("SIGTERM");
	signal?.addEventListener("abort", onAbort, { once: true });

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: {
			type?: string;
			message?: { role?: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string };
		};
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "tool_execution_end") {
			const toMain = toMainMessage(event);
			if (toMain) options.onMessageToMain?.(toMain.message, toMain.summary);
		} else if (event.type === "tool_execution_start") {
			toolCalls++;
			const start = event as { toolName?: string; args?: unknown };
			if (start.toolName) recordAction(actions, start.toolName, start.args);
			onProgress(toolCalls, finalText, usage);
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			addUsage(usage, event.message.usage);
			providerError = providerErrorFrom(event.message);
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
			resolve({ output: `Failed to start subagent: ${error.message}`, toolCalls, usage, actions, failed: true });
		});

		child.on("close", (code, closeSignal) => {
			signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			resolve(closeOutcome({ finalText, providerError, code, closeSignal, stderr, toolCalls, usage, actions }));
		});
	});

	return {
		result,
		kill: () => child.kill("SIGTERM"),
		snapshot: () => ({ toolCalls, text: finalText, usage }),
	};
}

export interface RpcChildOptions extends Omit<ChildOptions, "task" | "signal" | "onProgress"> {
	onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void;
	/** Fires at the end of EVERY turn (initial task and later messages alike). */
	onTurnEnd: (outcome: ChildOutcome) => void;
	onExit?: () => void;
}

export interface RpcChildHandle {
	/**
	 * Deliver a message. "started" = the child was idle and this began a new
	 * turn (onTurnEnd will fire for it); "steered" = the child was mid-turn and
	 * the message joined it (covered by that turn's onTurnEnd).
	 */
	send(message: string): "started" | "steered";
	busy(): boolean;
	exited(): boolean;
	kill(): void;
	snapshot(): { toolCalls: number; text: string; usage: UsageTotals };
}

/**
 * Resident child over `pi --mode rpc`: same event stream as json mode, plus a
 * stdin command channel — which is what makes messaging a *running* agent
 * possible (`streamingBehavior: "steer"` queues into the current turn; when
 * idle the same command starts a new turn, so there is no idle/busy race).
 * RPC children have hasUI=true, so extension_ui_request dialogs must be
 * answered: every one is cancelled, which reproduces print-mode's
 * non-interactive fallback (gated tools deny instead of deadlocking).
 */
export function startRpcChild(options: RpcChildOptions): RpcChildHandle {
	const args = ["--mode", "rpc", ...buildChildFlags(options)];
	const invocation = piInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
	});

	const tracker = new RpcTurnTracker();
	let buffer = "";
	let stderr = "";
	let exited = false;
	/**
	 * Messages accepted while a prompt was sent but the child's agent loop had
	 * not started yet (it boots for a few seconds) — a steer written in that
	 * window would run as its own turn instead of joining the pending one.
	 * Flushed as steers the moment the child reports agent_start.
	 */
	let earlySteers: string[] = [];

	const send = (command: Record<string, unknown>) => {
		try {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		} catch {
			// A dead pipe surfaces via the close handler.
		}
	};

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let idx: number;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			const action = tracker.process(line);
			if (!action) continue;
			if (action.kind === "ui_request") {
				send({ type: "extension_ui_response", id: action.id, cancelled: true });
			} else if (action.kind === "stream_start") {
				for (const message of earlySteers) {
					send({ type: "prompt", message, streamingBehavior: "steer" });
				}
				earlySteers = [];
			} else if (action.kind === "progress") {
				options.onProgress(tracker.toolCalls, tracker.turnText, tracker.usage);
			} else if (action.kind === "message_to_main") {
				options.onMessageToMain?.(action.message, action.summary);
			} else if (action.kind === "turn_end") {
				options.onTurnEnd(turnOutcome());
			}
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const turnOutcome = (): ChildOutcome => {
		const output = tracker.turnText.slice(0, OUTPUT_CAP);
		if (tracker.providerError) {
			return {
				output: output.trim()
					? `${output}\n\n[The subagent's last request ended with a provider error: ${tracker.providerError}]`
					: `Subagent failed with a provider error (its model could not be called — an auth/billing/rate-limit problem, not a task failure): ${tracker.providerError}`,
				toolCalls: tracker.toolCalls,
				usage: tracker.usage,
				actions: tracker.actions,
				failed: true,
			};
		}
		if (output.trim()) return { output, toolCalls: tracker.toolCalls, usage: tracker.usage, actions: tracker.actions };
		const detail = stderr.trim().split("\n").slice(-5).join("\n");
		return {
			output: `Subagent produced no output.${detail ? `\n${detail}` : ""}`,
			toolCalls: tracker.toolCalls,
			usage: tracker.usage,
			actions: tracker.actions,
			failed: true,
		};
	};

	const onClose = () => {
		if (exited) return;
		exited = true;
		if (tracker.busy) {
			tracker.busy = false;
			const detail = stderr.trim().split("\n").slice(-5).join("\n");
			const provider = tracker.providerError ? `\nLast provider error: ${tracker.providerError}` : "";
			options.onTurnEnd({
				output: `Subagent exited mid-turn.${provider}${detail ? `\n${detail}` : ""}`,
				toolCalls: tracker.toolCalls,
				usage: tracker.usage,
				actions: tracker.actions,
				failed: true,
			});
		}
		options.onExit?.();
	};
	child.on("close", onClose);
	child.on("error", onClose);

	return {
		send(message: string): "started" | "steered" {
			if (exited) throw new Error("subagent process has exited");
			if (!tracker.busy) {
				tracker.beginTurn();
				send({ type: "prompt", message, streamingBehavior: "steer" });
				return "started";
			}
			if (tracker.streaming) {
				send({ type: "prompt", message, streamingBehavior: "steer" });
			} else {
				earlySteers.push(message);
			}
			return "steered";
		},
		busy: () => tracker.busy,
		exited: () => exited,
		kill: () => child.kill("SIGTERM"),
		snapshot: () => ({
			toolCalls: tracker.toolCalls,
			text: tracker.busy && tracker.turnText ? `${tracker.transcript ? `${tracker.transcript}\n\n---\n\n` : ""}${tracker.turnText}` : tracker.transcript,
			usage: tracker.usage,
		}),
	};
}
