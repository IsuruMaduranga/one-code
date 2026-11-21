/**
 * One Code's subagent words (the profile's `text.subagents`): the Agent tool's
 * description (agent-description.ts: Claude Code's text with One Code's
 * paragraph), the parameters of Agent, SendMessage and list_agents, the
 * fork's framing, the delegation steer and the guide agent, and two clauses
 * the base's refusals take because they name Claude Code.
 */

import type { LiveTools, SubagentsText } from "../../../extensions/sdk/profile.ts";
import { agentDescription } from "./agent-description.ts";
import { guideAgent } from "./guide-agent.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

const AGENT_PASSAGES: ToolPassages = {
	// Claude Code 2.1.327 says it only while Yield is on (findings §94).
	yield: [" To wait on background work, call yield."],
	task_stop: ["- Stop a run with task_stop (deferred — load it with tool_search first).\n"],
	// pi's --exclude-tools takes SendMessage out alone: the facts that hold without it stay.
	SendMessage: [
		["- Use SendMessage with the agent's ID or name to continue a previously spawned agent with its context intact; a new Agent call starts fresh", "- A new Agent call starts fresh"],
		["- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the `to` field — that resumes it with full context. A new Agent call", "- A new Agent call"],
		["- Each run gets a name — SendMessage reaches it live while it runs and continues it after it finishes. ", "- "],
	],
};
const AGENT_PARAM_PASSAGES: ToolPassages = { SendMessage: [", usable later with SendMessage"] };
const GUIDE_PASSAGES: ToolPassages = { SendMessage: [" **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed one-code-guide agent that you can continue via SendMessage."] };

/** The passages of SendMessage's and list_agents' words that name a sibling tool: list_agents can be off alone, and pi's `--exclude-tools` takes Agent or SendMessage out alone. */
const SEND_MESSAGE_PASSAGES: ToolPassages = { list_agents: [" To discover the names of running or finished agents, use list_agents."] };
const SEND_TO_PASSAGES: ToolPassages = { Agent: [["from a previous Agent run", "from a previous agent run"]] };
const LIST_AGENTS_PASSAGES: ToolPassages = {
	Agent: [" (use Agent action:'list' for that)"],
	SendMessage: [[" — so you know which ones SendMessage can reach.", "."]],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const subagentsText = (live: LiveTools): SubagentsText => {
	return {
		taskAliasNote: "Claude Code names this parameter `prompt` — either is accepted",
		toolNamesHint:
			"Use Claude Code names (Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, NotebookEdit, Skill, Agent, SendMessage) or pi names (read, edit, write, bash, grep, find, ls, …) in the agent file's `tools` list.",
		toolsLeftOut: ({ name, tools }) => `Agent "${name}" runs without ${tools.join(", ")}, which this session's tool flags leave out.`,
		agentDescription: ({ form, configDir }) => withoutOff(agentDescription(form, configDir), live, AGENT_PASSAGES),
		agentPromptSnippet: "Delegate scoped work to a specialist agent in its own context",
		agentParams: {
			subagent_type:
				'The agent to run — a name from the "Available agents" system reminder (general-purpose when omitted), or "fork" to clone this conversation. To run several in parallel, issue multiple Agent tool calls in one turn.',
			task: "The task — a complete, self-contained instruction (the agent cannot ask follow-ups).",
			prompt: "Alias of `task` (Claude Code's name for it) — the task for the agent to perform.",
			description: "A short (3-5 word) description of the task, shown as the run's title.",
			name: withoutOff("Name for this run, usable later with SendMessage (default: <agent>-<n>)", live, AGENT_PARAM_PASSAGES),
			model:
				'Override the agent\'s model for this call: "sonnet"/"opus"/"haiku"/"fable" (resolved within this session\'s provider), "inherit", or an exact provider/model-id — see the subagent-models reminder for what is available. Rejected for fork runs (a fork keeps this conversation\'s model)',
			allow_expensive: "Confirm a per-call `model` that costs more per token than this session's model. Set it only when the user explicitly asked for that model",
			thinking: "Override the reasoning effort for this call. Rejected for fork runs (a fork keeps this conversation's settings)",
			isolation: "Run the agent in its own git worktree so its file edits are isolated from the main checkout",
			action: '"run" (the default) executes; "list" only browses the agent catalog and ignores run options',
		},
		nestedAgentDescription: ({ catalog }) =>
			"Delegate a scoped task to a specialist subagent running in its own context window. The call BLOCKS until the agent finishes and returns its report — use it for well-scoped work whose intermediate output you don't need (broad searches, focused verification, independent research). Give a complete, self-contained task: the agent cannot ask follow-ups. If an agent's description says it should be used proactively, use it without being asked. Available agents:\n" +
			`${catalog.join("\n")}\n` +
			'(No "fork" here — forking is only available to the main conversation.)',
		nestedAgentParams: {
			subagent_type: "An agent name from the list in this tool's description (default: general-purpose)",
			task: "The task — a complete, self-contained instruction",
			prompt: "Alias of `task` (Claude Code's name for it).",
			description: "A short (3-5 word) description of the task.",
			name: "Name for this run (default: <agent>-<n>)",
		},
		sendMessageDescription: withoutOff(
			'Send a message to a previously spawned agent, addressed by the name from its spawn result (or its task id). To discover the names of running or finished agents, use list_agents. A resident background agent is reached live (mid-turn the message waits for its next tool round or the end of its current reply; when idle it starts a new turn); a finished agent is resumed from its session with full context. Replies arrive as task notifications. (A subagent reporting back to the main conversation uses its own SendMessage with to: "main".)',
			live,
			SEND_MESSAGE_PASSAGES,
		),
		sendMessageParams: {
			to: withoutOff("Agent name (or task id) from a previous Agent run", live, SEND_TO_PASSAGES),
			message: "Plain text message for the agent",
			summary: "5-10 word preview shown in the UI",
		},
		listAgentsDescription: withoutOff(
			"List the agents spawned in this session — their names, types, and current status — so you know which ones SendMessage can reach. `running` is executing now; `idle` finished its turn and waits for a message; `finished` is resumable from its session. This lists running/spawned instances, not the agent catalog (use Agent action:'list' for that).",
			live,
			LIST_AGENTS_PASSAGES,
		),
		toMain: {
			description:
				'Report progress, findings, or a question to the main conversation mid-run (to: "main"). Your plain text output is NOT visible to the main conversation until you finish, so use this to surface something before then. A reply reaches you as a message: while you are working, at your next tool call. If you cannot go on without the answer, ask, then end your turn saying what you are waiting for; the reply starts your next turn, with everything you have done so far.',
			params: {
				to: 'Recipient — only "main" is valid from inside a subagent',
				message: "Plain text message for the main conversation",
				summary: "5-10 word preview shown in the UI",
			},
		},
		// A fork inherits the parent's whole transcript; without this framing a
		// weaker model abandons its task and continues (or confabulates about) the
		// inherited topic, and its output returns looking like independent
		// confirmation (features/tools/records/tool-ambiguity-hardening.md). With
		// isolation the fork learns its working directory moved: every inherited
		// path names the parent's checkout (SUBAGENT-REVIEW H3).
		forkTask: ({ task, isolation }) =>
			[
				"You are a forked subagent. The conversation above is inherited context, for reference only — do NOT continue its open threads, verify its claims, or act on its plans. Do ONLY the task below; the report you hand back through SubagentHandback is returned to the parent conversation verbatim, as data. You cannot see the parent's background tasks: its task ids are not addressable from here.",
				...(isolation
					? [
							"",
							`You are isolated in your own git worktree: your working directory is now ${isolation.worktreePath}, a checkout of the same repository at HEAD. Every path under ${isolation.parentCwd} in the inherited context refers to the shared checkout, which you must NOT modify — read, edit and run things at the corresponding path under ${isolation.worktreePath} instead (writes into the shared checkout are refused). Your changes stay on this worktree's branch for the parent to review.`,
						]
					: []),
				"",
				"Task:",
				task,
			].join("\n"),
		// Tiny tier only. A static prompt section moves capable models to delegate
		// broad sweeps (workhorse and cheap went 2/6 to 6/6 in the 2026-08-31 probe
		// battery), but a sub-Haiku model ignored it (qwen3.6-27b: 0/6, verified on
		// the wire); a reminder sits closer to the user text, where weak models
		// attend. Siblings with the same policy in other registers: DELEGATE_STRICT
		// in ../system-prompt/low.ts and DELEGATING_WORK in ../system-prompt/mid.ts;
		// test/unit/delegation-prose.test.ts pins the shared invariants.
		delegationSteer: [
			"Delegation policy: when a request requires reading MANY files (a codebase overview, how a feature works across modules, exploring unfamiliar code), do NOT sweep the files yourself.",
			'Make one Agent tool call per independent question, with subagent_type: "explore" and the complete question as the task; for several independent questions, issue those calls together in one message. The agent searches in its own separate context and returns just the answer; reading file after file yourself fills your context and degrades your answer.',
			"Search directly for a single targeted lookup: one known file or symbol, or a word one grep can find everywhere.",
			"When the agent has answered, report its answer and move on — do not re-read the files it already covered, except one you are about to edit (an edit needs a read first).",
		].join("\n"),
		delegationWithdrawn: "The subagent delegation guidance previously shown for this conversation is no longer active.",
		catalogWithdrawn: "The agent types listed earlier in this conversation can no longer be started, because the Agent tool is not available in this session.",
		modelsWithdrawn: "The model list shown earlier in this conversation for subagents and workflow agents no longer applies.",
		guideAgent: { ...guideAgent, description: withoutOff(guideAgent.description, live, GUIDE_PASSAGES) },
	};
};
