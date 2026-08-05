/**
 * subagents extension — Claude Code's Agent/Task tool.
 *
 * Delegates a task to a specialist agent running in a separate pi process with
 * its own context window. Agent definitions come from `.claude/agents/*.md`
 * (project), `~/.claude/agents/*.md` (user), and the catalog bundled with this
 * package — the same markdown + frontmatter format Claude Code uses.
 *
 * Claude Code features covered here: several tasks in parallel, per-call `model`
 * and `thinking` overrides, `fork` (a child that inherits this conversation),
 * and `isolation: "worktree"`. Background/detached runs with TaskOutput/TaskStop
 * are not implemented.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDefinition, type AgentSource, agentDirs, discoverAgents } from "./agents.ts";
import { discoverPlugins } from "../lib/plugins.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "./worktree.ts";

const MAX_PARALLEL = 4;
const OUTPUT_CAP = 50_000;

/** The catalog shipped in this package: <package>/agents. */
const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

interface RunRequest {
	agent: string;
	task: string;
	/** Inherit the caller's conversation instead of starting from an agent prompt. */
	fork?: boolean;
	model?: string;
	thinking?: string;
	worktree?: boolean;
}

interface TaskResult {
	agent: string;
	task: string;
	output: string;
	toolCalls: number;
	failed?: boolean;
	worktreePath?: string;
	worktreeKept?: boolean;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
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

interface ChildOptions {
	agent?: AgentDefinition;
	task: string;
	cwd: string;
	/** Parent session file, for fork runs. */
	forkFrom?: string;
	model?: string;
	thinking?: string;
	signal: AbortSignal;
	onProgress: (toolCalls: number, lastText: string) => void;
}

function runChild(options: ChildOptions): Promise<Omit<TaskResult, "agent" | "task">> {
	const { agent, task, cwd, forkFrom, signal, onProgress } = options;
	const args = ["--mode", "json", "-p"];

	if (forkFrom) {
		// pi forks the session file into a fresh session, so the child starts with
		// the parent's transcript and our own system prompt still applies.
		args.push("--fork", forkFrom);
	} else {
		args.push("--no-session");
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
	if (agent?.tools && !forkFrom) args.push("--tools", agent.tools.join(","));
	args.push(task);

	const invocation = piInvocation(args);

	return new Promise((resolve) => {
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

		const onAbort = () => child.kill("SIGTERM");
		signal.addEventListener("abort", onAbort, { once: true });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "tool_execution_start") {
				toolCalls++;
				onProgress(toolCalls, finalText);
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const blocks = Array.isArray(event.message.content) ? event.message.content : [];
				const text = blocks
					.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
					.map((b) => b.text)
					.join("");
				if (text.trim()) {
					finalText = text;
					onProgress(toolCalls, finalText);
				}
			}
		};

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
			signal.removeEventListener("abort", onAbort);
			resolve({ output: `Failed to start subagent: ${error.message}`, toolCalls, failed: true });
		});

		child.on("close", (code, closeSignal) => {
			signal.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			const output = finalText.slice(0, OUTPUT_CAP);
			if (output.trim()) {
				resolve({ output, toolCalls });
				return;
			}
			const why = closeSignal ? `terminated by ${closeSignal}` : `exit code ${code}`;
			const detail = stderr.trim().split("\n").slice(-5).join("\n");
			resolve({
				output: `Subagent produced no output (${why}).${detail ? `\n${detail}` : ""}`,
				toolCalls,
				failed: true,
			});
		});
	});
}

const TaskShape = Type.Object({
	agent: Type.String({ description: "Agent name, or \"fork\" to clone this conversation" }),
	task: Type.String({ description: "Complete, self-contained instruction — the agent cannot ask follow-ups" }),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: 'Agent for a single run, or "fork" to clone this conversation' })),
	task: Type.Optional(Type.String({ description: "Task for a single run" })),
	tasks: Type.Optional(
		Type.Array(TaskShape, { description: `Run several agents in parallel (max ${MAX_PARALLEL} at a time)` }),
	),
	model: Type.Optional(Type.String({ description: "Override the agent's model for this call" })),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high"] as const, {
			description: "Override the reasoning effort for this call",
		}),
	),
	isolation: Type.Optional(
		StringEnum(["worktree"] as const, {
			description: "Run each agent in its own git worktree so parallel file edits cannot collide",
		}),
	),
	action: Type.Optional(StringEnum(["run", "list"] as const)),
});

async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

export const FORK_AGENT = "fork";

export default function subagentsExtension(pi: ExtensionAPI) {
	const loadAgents = (cwd: string) => {
		// Plugin agents sit between bundled and user definitions, and are exposed
		// namespaced (`<plugin>:<agent>`) so two plugins can ship the same name.
		const sources: Array<string | AgentSource> = [
			BUNDLED_AGENTS_DIR,
			...discoverPlugins(join(os.homedir(), ".claude")).agentDirs,
			...agentDirs(cwd, os.homedir()),
		];
		return discoverAgents(sources);
	};

	const describeAgents = (cwd: string) => {
		const agents = loadAgents(cwd);
		const lines = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`);
		lines.push(`- ${FORK_AGENT}: clone this conversation, with its full context, to work on a task in parallel`);
		return lines.join("\n");
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a specialist agent that runs in its own context window and reports back. Use it for well-scoped work whose intermediate output you don't need — broad codebase searches, focused reviews, independent research. Give a complete, self-contained task: the agent cannot ask follow-up questions. Pass `tasks` to run several in parallel, `agent: \"fork\"` for a child that inherits this conversation, or `isolation: \"worktree\"` when parallel agents will edit files. Use action:'list' to see available agents.",
		promptSnippet: "subagent - delegate scoped work to a specialist agent in its own context",
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(ctx.cwd);

			if (params.action === "list" || (!params.agent && !params.tasks)) {
				return {
					content: [{ type: "text", text: `Available agents:\n${describeAgents(ctx.cwd)}` }],
					details: { agents: agents.map((a) => a.name) },
				};
			}

			const requested: RunRequest[] = (
				params.tasks?.length ? params.tasks : [{ agent: params.agent ?? "", task: params.task ?? "" }]
			).map((entry) => ({
				agent: entry.agent,
				task: entry.task,
				fork: entry.agent === FORK_AGENT,
				model: params.model,
				thinking: params.thinking,
				worktree: params.isolation === "worktree",
			}));

			const sessionFile = ctx.sessionManager.getSessionFile();
			const forkRuns = requested.filter((r) => r.fork);
			if (forkRuns.length > 0 && !sessionFile) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot fork: this session is not persisted (started with --no-session), so there is no transcript to clone. Use a named agent instead.",
						},
					],
					details: {},
					isError: true,
				};
			}

			const unknown = requested.filter((r) => !r.fork && !agents.some((a) => a.name === r.agent));
			if (unknown.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent(s): ${unknown.map((u) => u.agent).join(", ")}\n\nAvailable agents:\n${describeAgents(ctx.cwd)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const wantsWorktree = requested.some((r) => r.worktree);
			if (wantsWorktree && !(await isGitRepo(ctx.cwd))) {
				return {
					content: [{ type: "text", text: "isolation: \"worktree\" needs a git repository; this directory is not one." }],
					details: {},
					isError: true,
				};
			}

			const progress = requested.map((r) => ({ agent: r.agent, toolCalls: 0, text: "" }));
			const report = () => {
				const lines = progress.map(
					(p) => `${p.text ? "✓" : "⏳"} ${p.agent} (${p.toolCalls} tools)${p.text ? "" : " running…"}`,
				);
				onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: {} });
			};
			report();

			const abortSignal = signal ?? new AbortController().signal;

			const results = await runPool(
				requested.map((request, index) => ({ request, index })),
				MAX_PARALLEL,
				async ({ request, index }): Promise<TaskResult> => {
					const agent = request.fork ? undefined : agents.find((a) => a.name === request.agent);

					let worktree: Worktree | undefined;
					if (request.worktree) {
						try {
							worktree = await createWorktree(ctx.cwd, request.agent);
						} catch (error) {
							return {
								agent: request.agent,
								task: request.task,
								output: `Could not create a worktree: ${(error as Error).message}`,
								toolCalls: 0,
								failed: true,
							};
						}
					}

					try {
						const result = await runChild({
							agent,
							task: request.task,
							cwd: worktree?.path ?? ctx.cwd,
							forkFrom: request.fork ? (sessionFile ?? undefined) : undefined,
							model: request.model,
							thinking: request.thinking,
							signal: abortSignal,
							onProgress: (toolCalls, text) => {
								progress[index] = { agent: request.agent, toolCalls, text };
								report();
							},
						});
						let worktreeKept: boolean | undefined;
						if (worktree) {
							worktreeKept = !(await cleanupWorktree(ctx.cwd, worktree));
						}
						return {
							agent: request.agent,
							task: request.task,
							...result,
							worktreePath: worktreeKept ? worktree?.path : undefined,
							worktreeKept,
						};
					} catch (error) {
						if (worktree) await cleanupWorktree(ctx.cwd, worktree);
						return {
							agent: request.agent,
							task: request.task,
							output: `Subagent failed: ${(error as Error).message}`,
							toolCalls: 0,
							failed: true,
						};
					}
				},
			);

			const text = results
				.map((r) => {
					const worktreeNote = r.worktreePath
						? `\n\n(Changes left in worktree ${r.worktreePath} — review or merge them.)`
						: "";
					return results.length > 1
						? `## ${r.agent}${r.failed ? " (failed)" : ""}\nTask: ${r.task}\n\n${r.output}${worktreeNote}`
						: `${r.output}${worktreeNote}`;
				})
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text }],
				details: { results },
				isError: results.every((r) => r.failed),
			};
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Available agents:\n${describeAgents(ctx.cwd)}`, "info");
		},
	});
}
