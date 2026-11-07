/**
 * One Code's subagent text (the profile's `text.subagents`): the Agent tool's
 * description (agent-description.ts: Claude Code's text with One Code's
 * paragraph), the parameters, results and refusals of Agent, SendMessage and
 * list_agents, a run's failures, the fork's framing, and the blocks the
 * extension adds to the conversation. Claude Code's wording where it has
 * one (the catalog rows, the anti-fabrication sentence, the hand-off
 * results); One Code's elsewhere.
 */

import type { AgentTools, LaunchLine, PendingRun, RunFailure, RunStatus, SubagentRefusal, SubagentsText } from "../../../extensions/subagents/text.ts";
import { checkoutProgram } from "../worktree/guard.ts";
import { agentDescription } from "./agent-description.ts";
import { guideAgent } from "./guide-agent.ts";
import { type ToolPassages, withoutOff } from "../../live-tools.ts";
import type { LiveTools } from "../../../extensions/lib/live-tools.ts";

/**
 * The anti-fabrication sentence, carried by the RESULT of a background spawn
 * and not only by the Agent tool's description, as Claude Code does ("You
 * know nothing about its results until that notification arrives…"). A
 * cheap-tier model that had the description in every request still wrote a
 * pending agent's answer before the notification arrived, then read the real
 * notification as confirmation of what it had invented
 * (WEAK-MODEL-REVIEW-2026-09-06 H1). This is the copy the model reads at the
 * point of action.
 */
const PENDING_RESULT =
	"You know nothing about the agent's result until that notification arrives: do not report, assume, or predict it, in prose or otherwise. If the request asks you to report what the agent found, that IS a step that cannot proceed without the result — call task_output with block=true and wait, rather than ending your turn with an answer you do not have yet.";

const TASK_REQUIRED = "`task` is required: a complete, self-contained instruction for the agent (Claude Code names this parameter `prompt` — either is accepted).";

// Claude Code closes every catalog row with a tools clause, the one place it
// tells the model an agent cannot edit: "*" for its built-in agents, "All
// tools" for an agent file that lists none.
function toolsClause(tools: AgentTools): string {
	if (tools.kind === "listed") return ` (Tools: ${tools.tools.join(", ") || "none"})`;
	if (tools.kind === "allExcept") return ` (Tools: All tools except ${tools.tools.join(", ")})`;
	return tools.builtIn ? " (Tools: *)" : " (Tools: All tools)";
}

function refused(refusal: SubagentRefusal): string {
	switch (refusal.kind) {
		case "hostNotReady":
			return "The host session is not ready to spawn agents — retry shortly.";
		case "nestedFork":
			return '"fork" is only available to the main conversation — pick a named agent instead.';
		case "nestedOptions": {
			const one = refusal.options.length === 1;
			return `${refusal.options.map((key) => `\`${key}\``).join(", ")} ${one ? "is" : "are"} not available to an Agent call made inside a subagent: a nested agent runs blocking, in this agent's directory, on its definition's model. Call again without ${one ? "it" : "them"}.`;
		}
		case "nestedUnknownAgent":
			return `${refusal.name ? `Unknown agent "${refusal.name}"` : "`subagent_type` is required"}. Available agents:\n${refusal.catalog.join("\n")}`;
		case "unknownAgents":
			return `Unknown agent(s): ${refusal.names.join(", ")}\n\nAvailable agents:\n${refusal.catalog.join("\n")}`;
		case "taskRequired":
			return TASK_REQUIRED;
		// Claude Code silently ignores `model` for forks; One Code fails loud.
		case "forkOverrides":
			return '`model`/`thinking` overrides are not applied to fork runs — a fork continues this conversation and keeps its exact model and reasoning settings. Drop the override, or use a named agent (e.g. "general-purpose") to run the task with different settings.';
		case "forkNotPersisted":
			return "Cannot fork: this session is not persisted (started with --no-session), so there is no transcript to clone. Use a named agent instead.";
		case "worktreeNeedsGit":
			return 'isolation: "worktree" needs a git repository; this directory is not one.';
		case "unknownModel":
			return `${refusal.reason ?? `Unknown model "${refusal.model}" — no available model matches it.`}\n\n${refusal.menu}`;
		case "expensiveModel":
			return `${refusal.gate}\nIf the user explicitly asked for this model, retry with allow_expensive: true; otherwise pick a cheaper model or omit the field.\n\n${refusal.menu}`;
		case "nestedDenied":
			return `Nested Agent call refused: ${refusal.reason}`;
		case "nestedNoBridge":
			return "Nested Agent call refused: no permission bridge is available to judge the delegation";
		case "nestedCheckFailed":
			return `Nested Agent call refused: permission check failed (${refusal.osMessage}).`;
		case "couldNotStart":
			return `Could not start the agent: ${refusal.problem}`;
		case "mainIsNotRecipient":
			return 'You are the main conversation — "main" is only a valid recipient from inside a subagent.';
		case "noRun":
			return `No run named "${refusal.to}". SendMessage only reaches agent runs already started this session — address them by their run name or task id, not by a catalog agent name. Start one with the Agent tool first if you haven't. Known runs: ${refusal.known.join(", ") || "(none)"}.`;
		case "deliveryFailed":
			return `Could not deliver the message to ${refusal.name}: ${refusal.osMessage}`;
		case "stillRunning":
			return `Agent ${refusal.name} is still running — wait for its completion notification, then resend.`;
		case "forkNotResumable":
			return `Agent ${refusal.name} is a fork whose system prompt was not persisted (it ran before fork resume was supported, or its files were removed), so it cannot be resumed faithfully. Start a fresh run instead.`;
		case "noSession":
			return `Agent ${refusal.name} has no persisted session to resume (it may have run before session persistence, or its files were removed).`;
		case "couldNotResume":
			return `Could not resume ${refusal.name}: ${refusal.problem}`;
		case "onlyMain":
			return `From inside a subagent the only recipient is "main" — got ${refusal.got}. Omit \`to\` or pass "main".`;
		case "messageRequired":
			return "`message` is required: pass the plain text to deliver to the main conversation.";
	}
}

function failure(f: RunFailure): string {
	switch (f.kind) {
		case "worktree":
			return `Could not create a worktree: ${f.osMessage}`;
		case "failed":
			return `Subagent failed: ${f.osMessage}`;
		case "turnNotStarted":
			return `Subagent could not start the turn: ${f.osMessage}`;
		case "aborted": {
			const why = f.why === "wallClock" ? "terminated: turn hit the wall-clock cap" : "terminated before the turn finished";
			return f.output.trim() ? `${f.output}\n\n[${why}]` : `Subagent ${why}.`;
		}
		case "providerError":
			return f.output.trim()
				? `${f.output}\n\n[The subagent's last request ended with a provider error: ${f.error}]`
				: `Subagent failed with a provider error (its model could not be called — an auth/billing/rate-limit problem, not a task failure): ${f.error}`;
	}
}

function launchLine(line: LaunchLine): string {
	switch (line.kind) {
		case "running":
			return `⏳ ${line.name} (task ${line.taskId}) running in background${line.logPath ? ` — interim output readable at ${line.logPath}` : ""}`;
		case "worktreeFailed":
			return `✗ ${line.name}: could not create a worktree: ${line.osMessage}`;
		case "startFailed":
			return `✗ ${line.name}: could not start: ${line.osMessage}`;
		case "sessionEnded":
			return `✗ ${line.name}: the session ended before the agent started.`;
	}
}

const STATUS: Record<RunStatus, string> = {
	resident: "resident (reachable live)",
	running: "running",
	// A one-shot run returned its report in the tool result and never
	// registered a background task, so pointing at task_output here would send
	// the model chasing an unknown id (WEAK-MODEL-REVIEW-2026-09-06 M3).
	finishedInline: "finished (one-shot run, report was returned inline)",
	finished: "finished (resume with SendMessage)",
};

/** The runs by name and task id, comma-separated. */
const namedRuns = (runs: readonly PendingRun[]): string => runs.map((run) => `${run.name} (task ${run.taskId})`).join(", ");

/** Names both task tools: cut when either is off. */
const TASK_TOOLS_PASSAGE = ["- Call task_output only if your next step cannot proceed without the result (block=true waits); stop a run with task_stop. Both are deferred — load them with tool_search first.\n"] as const;

/** The task tools in the results and notes of a run: what still holds when one is off. */
const RESULT_PASSAGES: ToolPassages = {
	task_output: [
		[" — call task_output with block=true and wait, rather than ending your turn with an answer you do not have yet.", " — tell the user you are waiting for it and end your turn without an answer; the notification brings the result."],
		" Call task_output only if your next step cannot proceed without the result (block=true waits).",
		["; inspect with task_output.", "."],
		[", and task_output does not know this id.", "."],
		["Wait for the notification, or call task_output with block=true.", "Wait for the notification."],
		" Use task_output to check on one, or task_stop to end it.",
	],
	task_stop: [["Stop with task_stop; SendMessage", "SendMessage"], [" Use task_output to check on one, or task_stop to end it.", " Use task_output to check on one."]],
};

const AGENT_PASSAGES: ToolPassages = {
	task_output: TASK_TOOLS_PASSAGE,
	task_stop: TASK_TOOLS_PASSAGE,
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const subagentsText = (live: LiveTools): SubagentsText => {
	/** A run's result or note without the task tools that are off. */
	const results = (text: string) => withoutOff(text, live, RESULT_PASSAGES);
	return {
		agentDescription: ({ form, configDir }) => withoutOff(agentDescription(form, configDir), live, AGENT_PASSAGES),
		agentPromptSnippet: "Delegate scoped work to a specialist agent in its own context",
		agentParams: {
			subagent_type:
				'The agent to run — a name from the "Available agents" system reminder (general-purpose when omitted), or "fork" to clone this conversation. To run several in parallel, issue multiple Agent tool calls in one turn.',
			task: "The task — a complete, self-contained instruction (the agent cannot ask follow-ups).",
			prompt: "Alias of `task` (Claude Code's name for it) — the task for the agent to perform.",
			description: "A short (3-5 word) description of the task, shown as the run's title.",
			name: "Name for this run, usable later with SendMessage (default: <agent>-<n>)",
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
		catalogRow: ({ name, description, tools }) => `- ${name}: ${description || "(no description)"}${toolsClause(tools)}`,
		forkRow: "- fork: clone this conversation, with its full context, to work on a task in parallel",
		catalogList: ({ rows }) => `Available agents:\n${rows.join("\n")}`,
		catalogBlock: ({ rows }) =>
			`Available agent types for the Agent tool:\n${rows.join("\n")}\n\nWhen you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.`,
		refused,
		runtimeProblem: (problem) =>
			problem.kind === "sessionEnded" ? "the session ended before the agent started" : `could not start the subagent runtime: ${problem.osMessage}`,
		failure,
		noOutput: "(Subagent completed but returned no output.)",
		modelFallback: ({ model, osMessage, fallback }) => `Subagent model ${model ?? "(none)"} was unavailable (${osMessage}); ran on the session model ${fallback} instead.`,
		renamed: ({ wanted, takenBy, name }) => `Note: the name "${wanted}" is already used by task ${takenBy} in this session; this run is named "${name}".`,
		unusableTools: ({ name, tools }) =>
			`Agent "${name}" lists tools (${tools.join(", ")}) that match no available tool. ` +
			"Use Claude Code names (Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, NotebookEdit, Skill, Agent, SendMessage) or pi names (read, edit, write, bash, grep, find, ls, …) in the agent file's `tools` list.",
		worktreeRefused: ({ program }) =>
			`Cannot create an isolation worktree: ${checkoutProgram(program)}. Create the worktree with an explicitly approved git worktree add command, then start a session there without automatic isolation.`,
		worktreeKept: ({ path, branch }) => `(Changes or commits left in worktree ${path}${branch ? ` on branch ${branch}` : ""} — review or merge them.)`,
		worktreeRunning: ({ path, branch }) =>
			`(Running in worktree ${path} on branch ${branch} — kept while the agent stays resident, and after it exits if it holds uncommitted changes or commits.)`,
		stats: ({ toolCalls, tokens, cost }) =>
			[`${toolCalls} tools`, ...(tokens ? [`${tokens} tokens`] : []), ...(tokens && cost && cost > 0 ? [`$${cost.toFixed(4)}`] : [])].join(" · "),
		// Said up front, in bash's and monitor's shared wording: a model told to
		// "retrieve the result with task_output" chased an id that was never
		// registered (WEAK-MODEL-REVIEW-2026-09-06 M3).
		inlineReport: ({ name, taskId, note }) =>
			results(`${name} (task ${taskId}): ${note} Its report follows here; there is no background task to poll, and task_output does not know this id.`),
		launched: ({ lines }) =>
			results(`${lines.join("\n")}\n\nCompletion (with the agent's report) will arrive as a task notification on its own — you do not need to wait for it or poll; keep working. ${PENDING_RESULT} Call task_output only if your next step cannot proceed without the result (block=true waits). Stop with task_stop; SendMessage reaches the agent even while it runs (the message is steered into its current turn).`),
		launchLine,
		sendMessageDescription:
			'Send a message to a previously spawned agent, addressed by the name from its spawn result (or its task id). To discover the names of running or finished agents, use list_agents. A resident background agent is reached live (mid-turn the message is steered into its current work; when idle it starts a new turn); a finished agent is resumed from its session with full context. Replies arrive as task notifications. (A subagent reporting back to the main conversation uses its own SendMessage with to: "main".)',
		sendMessageParams: {
			to: "Agent name (or task id) from a previous Agent run",
			message: "Plain text message for the agent",
			summary: "5-10 word preview shown in the UI",
		},
		steered: ({ name }) =>
			`Message steered into ${name}'s running turn — it will be taken into account before the turn completes, and the turn's completion notification will reflect it.`,
		nextTurn: ({ name }) =>
			results(`${name}'s turn had just finished; the message starts its next turn. The reply will arrive as a task notification from ${name}. ${PENDING_RESULT}`),
		sentToResident: ({ name, taskId }) =>
			results(`Message sent to resident agent ${name} (task ${taskId}). The reply will arrive as a task notification on its own; inspect with task_output. ${PENDING_RESULT}`),
		sent: ({ name, taskId }) => results(`Message sent to ${name} (task ${taskId}). The reply will arrive as a task notification on its own; inspect with task_output. ${PENDING_RESULT}`),
		inlineReply: ({ name, note }) => `${name}: ${note} Its reply follows here; there is no background task to poll.`,
		relocated: ({ name, cwd, worktreeRemoved, ranIn }) =>
			`[${name}'s working directory ${cwd} no longer exists${worktreeRemoved ? " (its isolation worktree was removed when the run left no changes)" : ""}; this turn ran in ${ranIn}.]`,
		listAgentsDescription:
			"List the agents spawned in this session — their names, types, and current status — so you know which ones SendMessage can reach. `running` is executing now; `resident` is idle but reachable live; `finished` is resumable from its session. This lists running/spawned instances, not the agent catalog (use Agent action:'list' for that).",
		noAgents: "No agents have been spawned in this session yet. Start one with the Agent tool.",
		agentList: ({ rows }) => `Agents spawned this session:\n${rows.join("\n")}`,
		agentRow: ({ name, agent, status, taskId }) => `- ${name} [${agent}] — ${STATUS[status]} (task ${taskId})`,
		toMain: {
			description:
				'Report progress, findings, or a question to the main conversation mid-run (to: "main"). Your plain text output is NOT visible to the main conversation until you finish, so use this to surface something before then.',
			params: {
				to: 'Recipient — only "main" is valid from inside a subagent',
				message: "Plain text message for the main conversation",
				summary: "5-10 word preview shown in the UI",
			},
			delivered: "Message delivered to the main conversation.",
		},
		fromSubagent: ({ name, summary, body }) => `Message from your subagent ${name}${summary ? ` (${summary})` : ""}:\n\n${body}`,
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
		parentMode: ({ mode }) =>
			`The main session's permission mode is now "${mode}", and your tool calls are checked against it from here on.${mode === "plan" ? " Only read-only tools run now: do not edit files or change state." : ""}`,
		// CONDITIONAL on purpose: the trigger also fires on correct behaviour (a
		// model that only said "I'm waiting for the agent"), so the text must not
		// accuse (subagents/pending-claim.ts).
		pendingClaim: ({ runs }) =>
			results(
				`You ended that turn while ${namedRuns(runs)} ${runs.length === 1 ? "was" : "were"} still running. ${runs.length === 1 ? "It has" : "They have"} not reported yet, ` +
					"so anything you stated about the result did not come from the agent — if you gave the user a result, say plainly in your next message that it was not the agent's and correct it. " +
					"Wait for the notification, or call task_output with block=true.",
			),
		runningAfterCompaction: ({ runs }) =>
			results(
				`Background agents you started before this conversation was compacted are still running: ${namedRuns(runs)}. Each one notifies you when it finishes; do not start the same work again. Use task_output to check on one, or task_stop to end it.`,
			),
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
		reviewTimedOut: "auto mode's review of this agent's actions did not finish before the report was delivered",
		guideAgent,
	};
};
