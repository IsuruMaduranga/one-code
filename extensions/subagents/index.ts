/**
 * subagents extension — Claude Code's Agent/Task tool.
 *
 * Delegates a task to a specialist agent running in a separate pi process with
 * its own context window. Agent definitions come from `.claude/agents/*.md`
 * (project) and `~/.claude/agents/*.md` (user), so Claude Code agent files work
 * unchanged. Supports one task or several in parallel.
 *
 * Modeled on pi's official subagent example (examples/extensions/subagent).
 * The child inherits this session's permission mode via CC_PERMISSION_MODE.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDefinition, agentDirs, discoverAgents } from "./agents.ts";

const MAX_PARALLEL = 4;
const OUTPUT_CAP = 50_000;

interface TaskResult {
	agent: string;
	task: string;
	output: string;
	toolCalls: number;
	failed?: boolean;
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

function runChild(
	agent: AgentDefinition,
	task: string,
	cwd: string,
	signal: AbortSignal,
	onProgress: (toolCalls: number, lastText: string) => void,
): Promise<TaskResult> {
	const tmpDir = mkdtempSync(join(os.tmpdir(), "cc-subagent-"));
	const promptPath = join(tmpDir, "system.md");
	writeFileSync(promptPath, agent.systemPrompt);

	const args = ["--mode", "json", "-p", "--no-session", "--system-prompt", promptPath];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools) args.push("--tools", agent.tools.join(","));
	args.push(task);

	const invocation = piInvocation(args);

	return new Promise<TaskResult>((resolve) => {
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
			resolve({ agent: agent.name, task, output: `Failed to start subagent: ${error.message}`, toolCalls, failed: true });
		});

		child.on("close", (code, closeSignal) => {
			signal.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			const output = finalText.slice(0, OUTPUT_CAP);
			if (output.trim()) {
				resolve({ agent: agent.name, task, output, toolCalls });
				return;
			}
			const why = closeSignal ? `terminated by ${closeSignal}` : `exit code ${code}`;
			const detail = stderr.trim().split("\n").slice(-5).join("\n");
			resolve({
				agent: agent.name,
				task,
				output: `Subagent produced no output (${why}).${detail ? `\n${detail}` : ""}`,
				toolCalls,
				failed: true,
			});
		});
	});
}

const TaskShape = Type.Object({
	agent: Type.String({ description: "Name of the agent to run (see the agent list in this tool's description)" }),
	task: Type.String({ description: "The task for the agent, written as a complete, self-contained instruction" }),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent for a single run" })),
	task: Type.Optional(Type.String({ description: "Task for a single run" })),
	tasks: Type.Optional(
		Type.Array(TaskShape, { description: `Run several agents in parallel (max ${MAX_PARALLEL} at a time)` }),
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

export default function subagentsExtension(pi: ExtensionAPI) {
	const loadAgents = (cwd: string) => discoverAgents(agentDirs(cwd, os.homedir()));

	const describeAgents = (cwd: string) => {
		const agents = loadAgents(cwd);
		if (agents.length === 0) return "(no agents defined; add .claude/agents/<name>.md)";
		return agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n");
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a specialist agent that runs in its own context window and reports back. Use it for well-scoped work whose intermediate output you don't need — broad codebase searches, focused reviews, independent research. Give a complete, self-contained task: the agent cannot ask follow-up questions. Pass `tasks` to run several agents in parallel. Use action:'list' to see available agents.",
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

			const requested = params.tasks?.length
				? params.tasks
				: [{ agent: params.agent ?? "", task: params.task ?? "" }];

			const unknown = requested.filter((r) => !agents.some((a) => a.name === r.agent));
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
				requested.map((r, index) => ({ ...r, index })),
				MAX_PARALLEL,
				async ({ agent: agentName, task, index }) => {
					const agent = agents.find((a) => a.name === agentName)!;
					return runChild(agent, task, ctx.cwd, abortSignal, (toolCalls, text) => {
						progress[index] = { agent: agentName, toolCalls, text };
						report();
					});
				},
			);

			const text = results
				.map((r) =>
					results.length > 1
						? `## ${r.agent}${r.failed ? " (failed)" : ""}\nTask: ${r.task}\n\n${r.output}`
						: r.output,
				)
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text }],
				details: { results },
				isError: results.every((r) => r.failed),
			};
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagents (.claude/agents)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Available agents:\n${describeAgents(ctx.cwd)}`, "info");
		},
	});
}
