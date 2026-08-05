/**
 * subagents extension — Claude Code's Agent/Task tool, plus send_message.
 *
 * Delegates a task to a specialist agent running in a separate pi process with
 * its own context window. Agent definitions come from `.claude/agents/*.md`
 * (project), `~/.claude/agents/*.md` (user), and the catalog bundled with this
 * package — the same markdown + frontmatter format Claude Code uses.
 *
 * Claude Code features covered: parallel tasks, per-call `model`/`thinking`
 * overrides, `fork` (a child inheriting this conversation), `isolation:
 * "worktree"`, `run_in_background` (detached runs addressable via
 * task_output/task_stop, completion delivered as a system notification), and
 * send_message (resume a finished agent with its context intact — children
 * persist their sessions per run to make that possible).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDefinition, type AgentSource, agentDirs, discoverAgents } from "./agents.ts";
import { discoverPlugins } from "../lib/plugins.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { type BackgroundTask, generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import {
	type ChildHandle,
	type ChildOutcome,
	OUTPUT_CAP,
	type RpcChildHandle,
	startChild,
	startRpcChild,
} from "./child.ts";
import { type AgentRunRecord, nextRunName, RunRegistry } from "./runs.ts";
import { emptyUsage, formatUsage, type UsageTotals } from "./usage.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "./worktree.ts";

const MAX_PARALLEL = 4;

/** The catalog shipped in this package: <package>/agents. */
const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

interface RunRequest {
	agent: string;
	task: string;
	name: string;
	/** Inherit the caller's conversation instead of starting from an agent prompt. */
	fork?: boolean;
	model?: string;
	thinking?: string;
	worktree?: boolean;
}

interface TaskResult {
	agent: string;
	name: string;
	taskId: string;
	task: string;
	output: string;
	toolCalls: number;
	usage: UsageTotals;
	failed?: boolean;
	worktreePath?: string;
	worktreeKept?: boolean;
}

const TaskShape = Type.Object({
	agent: Type.String({ description: 'Agent name, or "fork" to clone this conversation' }),
	task: Type.String({ description: "Complete, self-contained instruction — the agent cannot ask follow-ups" }),
	name: Type.Optional(Type.String({ description: "Name for this run, usable later with send_message (default: <agent>-<n>)" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: 'Agent for a single run, or "fork" to clone this conversation' })),
	task: Type.Optional(Type.String({ description: "Task for a single run" })),
	name: Type.Optional(Type.String({ description: "Name for a single run, usable later with send_message" })),
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
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately with a task id instead of waiting. Completion arrives as a system notification; inspect with task_output, stop with task_stop",
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

/** A background agent's process, kept alive after its run so it can be messaged. */
interface Resident {
	handle: RpcChildHandle;
	/** FIFO — the head entry handles the next turn_end (initial task, then one per idle-time message). */
	turnHandlers: Array<(outcome: ChildOutcome) => void>;
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const registry = new RunRegistry();
	/** Names with a foreground/respawned child currently running (send_message must wait for these). */
	const runningNames = new Set<string>();
	const liveChildren = new Set<{ kill(): void }>();
	const residents = new Map<string, Resident>();

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

	const reconstructRuns = (ctx: ExtensionContext) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || !["subagent", "send_message"].includes(msg.toolName ?? "")) continue;
			const records = (msg.details as { agentRuns?: AgentRunRecord[] } | undefined)?.agentRuns;
			for (const record of records ?? []) registry.add(record);
		}
	};
	pi.on("session_start", (_event, ctx) => reconstructRuns(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructRuns(ctx));
	pi.on("session_shutdown", () => {
		for (const child of liveChildren) child.kill();
	});

	const notify = (customType: string, text: string, details: Record<string, unknown>) => {
		pi.sendMessage(
			{ customType, content: [{ type: "text", text }], display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	/** Session dir for a run's persisted child session; undefined → child runs --no-session. */
	const runSessionDir = (ctx: ExtensionContext, taskId: string): string | undefined => {
		try {
			const dir = join(ctx.sessionManager.getSessionDir(), "subagents", taskId);
			mkdirSync(dir, { recursive: true });
			return dir;
		} catch {
			return undefined;
		}
	};

	interface PreparedRun {
		request: RunRequest;
		record: AgentRunRecord;
		agentDef?: AgentDefinition;
	}

	/** Start one child (creating a worktree first if asked) and finalize its record when done. */
	const executeRun = async (
		prepared: PreparedRun,
		ctx: ExtensionContext,
		forkFrom: string | undefined,
		signal: AbortSignal | undefined,
		onProgress: (toolCalls: number, text: string, usage: UsageTotals) => void,
		onStarted?: (handle: ChildHandle, worktree?: Worktree) => void,
	): Promise<TaskResult> => {
		const { request, record, agentDef } = prepared;

		let worktree: Worktree | undefined;
		if (request.worktree) {
			try {
				worktree = await createWorktree(ctx.cwd, request.name);
				record.cwd = worktree.path;
			} catch (error) {
				return {
					agent: request.agent,
					name: request.name,
					taskId: record.taskId,
					task: request.task,
					output: `Could not create a worktree: ${(error as Error).message}`,
					toolCalls: 0,
					usage: emptyUsage(),
					failed: true,
				};
			}
		}

		runningNames.add(request.name);
		const handle = startChild({
			agent: agentDef,
			task: request.task,
			cwd: record.cwd,
			forkFrom: request.fork ? forkFrom : undefined,
			sessionDir: record.sessionSearchDir || undefined,
			model: request.model,
			thinking: request.thinking,
			signal,
			onProgress,
		});
		liveChildren.add(handle);
		onStarted?.(handle, worktree);

		try {
			const outcome: ChildOutcome = await handle.result;
			registry.sessionFileFor(record); // resolve now that the child has written it
			let worktreeKept: boolean | undefined;
			if (worktree) {
				worktreeKept = !(await cleanupWorktree(ctx.cwd, worktree));
			}
			return {
				agent: request.agent,
				name: request.name,
				taskId: record.taskId,
				task: request.task,
				...outcome,
				worktreePath: worktreeKept ? worktree?.path : undefined,
				worktreeKept,
			};
		} catch (error) {
			if (worktree) await cleanupWorktree(ctx.cwd, worktree);
			return {
				agent: request.agent,
				name: request.name,
				taskId: record.taskId,
				task: request.task,
				output: `Subagent failed: ${(error as Error).message}`,
				toolCalls: 0,
				usage: emptyUsage(),
				failed: true,
			};
		} finally {
			liveChildren.delete(handle);
			runningNames.delete(request.name);
		}
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a specialist agent that runs in its own context window and reports back. Use it for well-scoped work whose intermediate output you don't need — broad codebase searches, focused reviews, independent research. Give a complete, self-contained task: the agent cannot ask follow-up questions. Pass `tasks` to run several in parallel, `agent: \"fork\"` for a child that inherits this conversation, `isolation: \"worktree\"` when parallel agents will edit files, or `run_in_background: true` to keep working while it runs (completion arrives as a notification; manage with task_output/task_stop). Each run gets a name — continue a finished agent later with send_message. Use action:'list' to see available agents.",
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

			const taken = new Set(registry.names());
			const requested: RunRequest[] = (
				params.tasks?.length
					? params.tasks
					: [{ agent: params.agent ?? "", task: params.task ?? "", name: params.name }]
			).map((entry) => {
				const name = entry.name || nextRunName(taken, entry.agent);
				taken.add(name);
				return {
					agent: entry.agent,
					task: entry.task,
					name,
					fork: entry.agent === FORK_AGENT,
					model: params.model,
					thinking: params.thinking,
					worktree: params.isolation === "worktree",
				};
			});

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (requested.some((r) => r.fork) && !sessionFile) {
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

			if (requested.some((r) => r.worktree) && !(await isGitRepo(ctx.cwd))) {
				return {
					content: [{ type: "text", text: 'isolation: "worktree" needs a git repository; this directory is not one.' }],
					details: {},
					isError: true,
				};
			}

			const prepared: PreparedRun[] = requested.map((request) => {
				const taskId = generateTaskId();
				return {
					request,
					agentDef: request.fork ? undefined : agents.find((a) => a.name === request.agent),
					record: {
						name: request.name,
						agent: request.agent,
						taskId,
						sessionSearchDir: runSessionDir(ctx, taskId) ?? "",
						cwd: ctx.cwd,
						model: request.model,
						thinking: request.thinking,
					},
				};
			});
			for (const p of prepared) registry.add(p.record);
			const records = prepared.map((p) => p.record);

			// --- Background: RPC children that stay resident after their run, so
			// send_message can reach them live (steer mid-turn, prompt when idle).
			if (params.run_in_background) {
				const lines: string[] = [];
				for (const p of prepared) {
					let worktree: Worktree | undefined;
					if (p.request.worktree) {
						try {
							worktree = await createWorktree(ctx.cwd, p.request.name);
							p.record.cwd = worktree.path;
						} catch (error) {
							lines.push(`✗ ${p.record.name}: could not create a worktree: ${(error as Error).message}`);
							continue;
						}
					}

					const logPath = p.record.sessionSearchDir ? join(p.record.sessionSearchDir, "output.log") : undefined;
					let finish!: () => void;
					const finished = new Promise<void>((resolve) => {
						finish = resolve;
					});

					const resident: Resident = { handle: undefined as never, turnHandlers: [] };
					const worktreeNote = worktree
						? `\n\n(Running in worktree ${worktree.path} — kept while the agent stays resident.)`
						: "";
					resident.turnHandlers.push((outcome) => {
						task.status = outcome.failed ? "failed" : "completed";
						task.finishedAt = Date.now();
						finish();
						const stats = [`${outcome.toolCalls} tools`, formatUsage(outcome.usage)].filter(Boolean).join(" · ");
						notify(
							"subagent-result",
							`SYSTEM NOTIFICATION — NOT USER INPUT\nBackground agent ${p.record.name} (${p.record.taskId}) ${outcome.failed ? "failed" : "completed"} (${stats}). It stays resident — message it with send_message.\n\n${outcome.output.slice(0, OUTPUT_CAP)}${worktreeNote}`,
							{ taskId: p.record.taskId, name: p.record.name, failed: outcome.failed ?? false },
						);
					});

					const handle = startRpcChild({
						agent: p.agentDef,
						cwd: p.record.cwd,
						forkFrom: p.request.fork ? (sessionFile ?? undefined) : undefined,
						sessionDir: p.record.sessionSearchDir || undefined,
						model: p.request.model,
						thinking: p.request.thinking,
						onProgress: (_toolCalls, text) => {
							if (logPath && text) writeFileSync(logPath, text);
						},
						onTurnEnd: (outcome) => {
							registry.sessionFileFor(p.record);
							if (logPath) writeFileSync(logPath, resident.handle.snapshot().text || outcome.output);
							const handler = resident.turnHandlers.shift();
							if (handler) {
								handler(outcome);
							} else {
								// A turn nobody is waiting on (e.g. a steer that raced past its
								// target turn and ran on its own) must still surface.
								notify(
									"subagent-result",
									`SYSTEM NOTIFICATION — NOT USER INPUT\nUpdate from ${p.record.name}:\n\n${outcome.output.slice(0, OUTPUT_CAP)}`,
									{ name: p.record.name, failed: outcome.failed ?? false },
								);
							}
						},
						onExit: () => {
							liveChildren.delete(handle);
							if (residents.get(p.record.name) === resident) residents.delete(p.record.name);
							if (worktree) void cleanupWorktree(ctx.cwd, worktree);
						},
					});
					resident.handle = handle;
					residents.set(p.record.name, resident);
					liveChildren.add(handle);

					const task: BackgroundTask = {
						id: p.record.taskId,
						kind: "subagent",
						description: `${p.record.name}: ${p.request.task.slice(0, 80)}`,
						status: "running",
						startedAt: Date.now(),
						logPath,
						output: () => handle.snapshot().text,
						stop: () => handle.kill(),
						resident: () => !handle.exited(),
						finished,
					};
					pi.events.emit(TASK_REGISTER_CHANNEL, task);
					handle.send(p.request.task);

					lines.push(
						`⏳ ${p.record.name} (task ${p.record.taskId}) running in background${logPath ? ` — output log: ${logPath}` : ""}`,
					);
				}
				return {
					content: [
						{
							type: "text",
							text: `${lines.join("\n")}\n\nCompletion will arrive as a system notification. Inspect with task_output, stop with task_stop — and send_message reaches the agent even while it runs (the message is steered into its current turn).`,
						},
					],
					details: { agentRuns: records, background: true },
				};
			}

			// --- Foreground: bounded pool, live progress, blocking result.
			const progress = requested.map((r) => ({ name: r.name, toolCalls: 0, text: "", usage: emptyUsage() }));
			const report = () => {
				const lines = progress.map((p) => {
					const stats = [`${p.toolCalls} tools`, formatUsage(p.usage)].filter(Boolean).join(", ");
					return `${p.text ? "✓" : "⏳"} ${p.name} (${stats})${p.text ? "" : " running…"}`;
				});
				onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: {} });
			};
			report();

			const results = await runPool(
				prepared.map((p, index) => ({ p, index })),
				MAX_PARALLEL,
				({ p, index }) =>
					executeRun(p, ctx, sessionFile ?? undefined, signal, (toolCalls, text, usage) => {
						progress[index] = { name: p.request.name, toolCalls, text, usage };
						report();
					}),
			);

			const text = results
				.map((r) => {
					const stats = [`${r.toolCalls} tools`, formatUsage(r.usage)].filter(Boolean).join(" · ");
					const worktreeNote = r.worktreePath
						? `\n\n(Changes left in worktree ${r.worktreePath} — review or merge them.)`
						: "";
					return results.length > 1
						? `## ${r.name}${r.failed ? " (failed)" : ""} (${stats})\nTask: ${r.task}\n\n${r.output}${worktreeNote}`
						: `${r.output}${worktreeNote}\n\n(${stats})`;
				})
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text }],
				details: { results, agentRuns: records },
				isError: results.every((r) => r.failed),
			};
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to a previously spawned subagent, addressed by the name from its spawn result (or task id). A resident background agent is reached live: mid-turn the message is steered into its current work; when idle it starts a new turn and the reply arrives as a system notification. A finished, non-resident agent is resumed from its session file with full context.",
		parameters: Type.Object({
			to: Type.String({ description: "Agent name (or task id) from a previous subagent run" }),
			message: Type.String({ description: "Plain text message for the agent" }),
			summary: Type.Optional(Type.String({ description: "5-10 word preview shown in the UI" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = registry.resolve(params.to);
			if (!record) {
				const known = registry.names().join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `No agent named "${params.to}". Known agents: ${known}` }],
					details: {},
					isError: true,
				};
			}
			// Resident background agent: reach it live over its RPC channel.
			const resident = residents.get(record.name);
			if (resident && !resident.handle.exited()) {
				if (resident.handle.busy()) {
					resident.handle.send(params.message);
					return {
						content: [
							{
								type: "text",
								text: `Message steered into ${record.name}'s running turn — it will be taken into account before the turn completes, and the turn's completion notification will reflect it.`,
							},
						],
						details: { agentRuns: [record], steered: true },
					};
				}

				const taskId = generateTaskId();
				let finish!: () => void;
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const task: BackgroundTask = {
					id: taskId,
					kind: "subagent",
					description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
					status: "running",
					startedAt: Date.now(),
					output: () => resident.handle.snapshot().text,
					stop: () => resident.handle.kill(),
					resident: () => !resident.handle.exited(),
					finished,
				};
				resident.turnHandlers.push((outcome) => {
					task.status = outcome.failed ? "failed" : "completed";
					task.finishedAt = Date.now();
					finish();
					const stats = [`${outcome.toolCalls} tools`, formatUsage(outcome.usage)].filter(Boolean).join(" · ");
					notify(
						"subagent-result",
						`SYSTEM NOTIFICATION — NOT USER INPUT\nReply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`,
						{ taskId, name: record.name, failed: outcome.failed ?? false },
					);
				});
				pi.events.emit(TASK_REGISTER_CHANNEL, task);
				resident.handle.send(params.message);
				return {
					content: [
						{
							type: "text",
							text: `Message sent to resident agent ${record.name} (task ${taskId}). The reply will arrive as a system notification; inspect with task_output.`,
						},
					],
					details: { agentRuns: [record], taskId },
				};
			}

			if (runningNames.has(record.name)) {
				return {
					content: [
						{ type: "text", text: `Agent ${record.name} is still running — wait for its completion notification, then resend.` },
					],
					details: {},
					isError: true,
				};
			}
			const sessionFile = registry.sessionFileFor(record);
			if (!sessionFile) {
				return {
					content: [
						{ type: "text", text: `Agent ${record.name} has no persisted session to resume (it may have run before session persistence, or its files were removed).` },
					],
					details: {},
					isError: true,
				};
			}

			const taskId = generateTaskId();
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});

			runningNames.add(record.name);
			const handle = startChild({
				task: params.message,
				cwd: record.cwd,
				sessionFile,
				model: record.model,
				thinking: record.thinking,
				onProgress: () => {},
			});
			liveChildren.add(handle);

			const task: BackgroundTask = {
				id: taskId,
				kind: "subagent",
				description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
				status: "running",
				startedAt: Date.now(),
				output: () => handle.snapshot().text,
				stop: () => handle.kill(),
				finished,
			};
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			void handle.result.then((outcome) => {
				liveChildren.delete(handle);
				runningNames.delete(record.name);
				task.status = outcome.failed ? "failed" : "completed";
				task.finishedAt = Date.now();
				finish();
				const stats = [`${outcome.toolCalls} tools`, formatUsage(outcome.usage)].filter(Boolean).join(" · ");
				notify(
					"subagent-result",
					`SYSTEM NOTIFICATION — NOT USER INPUT\nReply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`,
					{ taskId, name: record.name, failed: outcome.failed ?? false },
				);
			});

			return {
				content: [
					{
						type: "text",
						text: `Message sent to ${record.name} (task ${taskId}). The reply will arrive as a system notification; inspect with task_output.`,
					},
				],
				details: { agentRuns: [record], taskId },
			};
		},
	});
	pi.events.emit(DEFER_CHANNEL, { name: "send_message", keywords: ["message", "agent", "resume", "continue", "teammate"] });

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Available agents:\n${describeAgents(ctx.cwd)}`, "info");
		},
	});
}
