/**
 * The words of what subagent runs report: the agent catalog block, launch
 * lines, refusals and failures, worktree notes, SendMessage results and the
 * notes about runs still going. The Agent tool and workflow agents show
 * them alike, and lib modules word some (the catalog, a run's worktree, its
 * usage), so they live here. The tools' own words and the delegation policy
 * are the profile's (`SubagentsText`, agents/subagents/text.ts).
 */
import { type LiveTools, type ToolPassages, withoutOff } from "../profile/live-tools.ts";
import { wordsInForce } from "../profile/live-words.ts";
import { checkoutProgram } from "../rules/worktree-guard-text.ts";
import type { CheckoutProgram } from "../shell/git-checkout-programs.ts";

/**
 * The profile's clauses in these words (`SubagentsText`): the note on the
 * alias of `task` in the refusal for a call without one, and the sentence on
 * the names an agent file's `tools` list may use.
 */
export interface SubagentClauses {
	taskAliasNote: string;
	toolNamesHint: string;
}

/** What an agent may use, as its catalog row says. */
export type AgentTools =
	/** Empty when every tool the agent lists is off. */
	| { kind: "listed"; tools: string[] }
	| { kind: "allExcept"; tools: string[] }
	/** `builtIn`: a built-in or bundled agent (Claude Code writes `*` for those). */
	| { kind: "all"; builtIn: boolean };

/** A run the model started that has not reported yet. */
export interface PendingRun {
	name: string;
	taskId: string;
}

/** Why an Agent call (main or nested) or a SendMessage call was refused. */
export type SubagentRefusal =
	/** A nested call arrived before the host session was ready. */
	| { kind: "hostNotReady" }
	/** A nested call asked for a fork. */
	| { kind: "nestedFork" }
	/** A nested call passed options only the main conversation's Agent tool has. */
	| { kind: "nestedOptions"; options: string[] }
	/** A nested call named no agent (`name` absent) or an unknown one; `catalog` is the rows. */
	| { kind: "nestedUnknownAgent"; name?: string; catalog: string[] }
	| { kind: "unknownAgents"; names: string[]; catalog: string[] }
	/** No task given. */
	| { kind: "taskRequired" }
	/** A fork with a `model` or `thinking` override. */
	| { kind: "forkOverrides" }
	/** A fork in a session with no session file. */
	| { kind: "forkNotPersisted" }
	| { kind: "worktreeNeedsGit" }
	/** `reason` is the resolver's own, when it has one; `menu` the models note (lib/models/subagent-model-text.ts). */
	| { kind: "unknownModel"; model: string; reason?: string; menu: string }
	/** `gate` is the expensive-model gate's sentence. */
	| { kind: "expensiveModel"; gate: string; menu: string }
	/** The parent's gate refused a nested delegation; `reason` is the gate's. */
	| { kind: "nestedDenied"; reason: string }
	/** No parent bridge to judge a nested delegation. */
	| { kind: "nestedNoBridge" }
	| { kind: "nestedCheckFailed"; osMessage: string }
	/** The runtime could not start (`problem` worded by `runtimeProblem`). */
	| { kind: "couldNotStart"; problem: string }
	/** SendMessage from the main conversation to "main". */
	| { kind: "mainIsNotRecipient" }
	/** SendMessage to a name or id no run has; `known` lists the runs. */
	| { kind: "noRun"; to: string; known: string[] }
	| { kind: "deliveryFailed"; name: string; osMessage: string }
	| { kind: "stillRunning"; name: string }
	/** A fork whose system prompt was not persisted. */
	| { kind: "forkNotResumable"; name: string }
	| { kind: "noSession"; name: string }
	| { kind: "couldNotResume"; name: string; problem: string }
	/** A subagent's SendMessage to someone other than "main"; `got` is the value as JSON. */
	| { kind: "onlyMain"; got: string }
	/** A subagent's SendMessage with no message. */
	| { kind: "messageRequired" };

/** Why the subagent runtime is not there. */
export type RuntimeProblem = { kind: "sessionEnded" } | { kind: "failed"; osMessage: string };

/** How a run ended short; `output` is what the agent wrote before it did. */
export type RunFailure =
	| { kind: "worktree"; osMessage: string }
	| { kind: "failed"; osMessage: string }
	| { kind: "turnNotStarted"; osMessage: string }
	/** The run was stopped (`stopped`) or hit the wall-clock cap (`wallClock`). */
	| { kind: "aborted"; why: "stopped" | "wallClock"; output: string }
	| { kind: "providerError"; error: string; output: string };

/** How a background launch went, one line per run in the Agent result. */
export type LaunchLine =
	| { kind: "running"; name: string; taskId: string; logPath?: string }
	| { kind: "worktreeFailed"; name: string; osMessage: string }
	| { kind: "startFailed"; name: string; osMessage: string }
	| { kind: "sessionEnded"; name: string };

/** A spawned run's status in list_agents (and the /agents fallback). */
export type RunStatus = "resident" | "running" | "finishedInline" | "finished";

/** The group's results, refusals and notes, which the base words (`subagentResultText`). */
export interface SubagentsResultText {
	/** One catalog row. */
	catalogRow(p: { name: string; description: string; tools: AgentTools }): string;
	/** The fork's catalog row. */
	forkRow: string;
	/** The Agent tool's list result. */
	catalogList(p: { rows: string[] }): string;
	/** The catalog block in the first message. */
	catalogBlock(p: { rows: string[] }): string;
	refused(refusal: SubagentRefusal): string;
	runtimeProblem(problem: RuntimeProblem): string;
	failure(failure: RunFailure): string;
	/** The report of a run that finished without writing anything. */
	noOutput: string;
	/** The note when a run fell back to the session model. */
	modelFallback(p: { model?: string; osMessage: string; fallback: string }): string;
	/** A requested run name already taken. */
	renamed(p: { wanted: string; takenBy: string; name: string }): string;
	/** An agent file whose `tools` list matches no tool. */
	unusableTools(p: { name: string; tools: string[] }): string;
	/** Creating an isolation worktree was refused; `program` names what git would run. */
	worktreeRefused(p: { program: CheckoutProgram }): string;
	/** A worktree kept because it holds the agent's work. */
	worktreeKept(p: { path: string; branch?: string }): string;
	/** A resident running in a worktree, on its report. */
	worktreeRunning(p: { path: string; branch: string }): string;
	/** The run statistics after a report (`tokens` formatted, `cost` in dollars, both absent when unknown). */
	stats(p: { toolCalls: number; tokens?: string; cost?: number }): string;
	/** A one-shot session's inline report; `note` is the shared one-shot note. */
	inlineReport(p: { name: string; taskId: string; note: string }): string;
	/** A background launch's result. */
	launched(p: { lines: string[] }): string;
	launchLine(line: LaunchLine): string;
	/** SendMessage results. */
	steered(p: { name: string }): string;
	nextTurn(p: { name: string }): string;
	sentToResident(p: { name: string; taskId: string }): string;
	sent(p: { name: string; taskId: string }): string;
	/** A one-shot session's inline reply; `note` is the shared one-shot note. */
	inlineReply(p: { name: string; note: string }): string;
	/** The resumed run's working directory is gone; it ran in `ranIn`. */
	relocated(p: { name: string; cwd: string; worktreeRemoved: boolean; ranIn: string }): string;
	noAgents: string;
	agentList(p: { rows: string[] }): string;
	agentRow(p: { name: string; agent: string; status: RunStatus; taskId: string }): string;
	/** A nested agent's message relayed to its resident parent. */
	fromSubagent(p: { name: string; summary?: string; body: string }): string;
	/** A fork told the parent's permission mode changed. */
	parentMode(p: { mode: string }): string;
	/** A turn ended while runs it started were still going. */
	pendingClaim(p: { runs: PendingRun[] }): string;
	/** Background runs still going after a compaction. */
	runningAfterCompaction(p: { runs: PendingRun[] }): string;
	/** Auto mode's review of a resident's actions did not finish in time. */
	reviewTimedOut: string;
}

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


// Claude Code closes every catalog row with a tools clause, the one place it
// tells the model an agent cannot edit: "*" for its built-in agents, "All
// tools" for an agent file that lists none.
function toolsClause(tools: AgentTools): string {
	if (tools.kind === "listed") return ` (Tools: ${tools.tools.join(", ") || "none"})`;
	if (tools.kind === "allExcept") return ` (Tools: All tools except ${tools.tools.join(", ")})`;
	return tools.builtIn ? " (Tools: *)" : " (Tools: All tools)";
}

function refused(refusal: SubagentRefusal, product: SubagentClauses): string {
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
			return `\`task\` is required: a complete, self-contained instruction for the agent (${product.taskAliasNote}).`;
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

/** The base's words of the group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const subagentResultWords = (live: LiveTools, product: SubagentClauses): SubagentsResultText => {
	/** A run's result or note without the task tools that are off. */
	const results = (text: string) => withoutOff(text, live, RESULT_PASSAGES);
	return {
		catalogRow: ({ name, description, tools }) => `- ${name}: ${description || "(no description)"}${toolsClause(tools)}`,
		forkRow: "- fork: clone this conversation, with its full context, to work on a task in parallel",
		catalogList: ({ rows }) => `Available agents:\n${rows.join("\n")}`,
		catalogBlock: ({ rows }) =>
			`Available agent types for the Agent tool:\n${rows.join("\n")}\n\nWhen you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.`,
		refused: (refusal) => refused(refusal, product),
		runtimeProblem: (problem) =>
			problem.kind === "sessionEnded" ? "the session ended before the agent started" : `could not start the subagent runtime: ${problem.osMessage}`,
		failure,
		noOutput: "(Subagent completed but returned no output.)",
		modelFallback: ({ model, osMessage, fallback }) => `Subagent model ${model ?? "(none)"} was unavailable (${osMessage}); ran on the session model ${fallback} instead.`,
		renamed: ({ wanted, takenBy, name }) => `Note: the name "${wanted}" is already used by task ${takenBy} in this session; this run is named "${name}".`,
		unusableTools: ({ name, tools }) => `Agent "${name}" lists tools (${tools.join(", ")}) that match no available tool. ${product.toolNamesHint}`,
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
		noAgents: "No agents have been spawned in this session yet. Start one with the Agent tool.",
		agentList: ({ rows }) => `Agents spawned this session:\n${rows.join("\n")}`,
		agentRow: ({ name, agent, status, taskId }) => `- ${name} [${agent}] — ${STATUS[status]} (task ${taskId})`,
		fromSubagent: ({ name, summary, body }) => `Message from your subagent ${name}${summary ? ` (${summary})` : ""}:\n\n${body}`,
		parentMode: ({ mode }) =>
			`The main session's permission mode is now "${mode}", and your tool calls are checked against it from here on.${mode === "plan" ? " Only read-only tools run now: do not edit files or change state." : ""}`,
		// CONDITIONAL on purpose: the trigger also fires on correct behaviour (a
		// model that only said "I'm waiting for the agent"), so the text must not
		// accuse (agents/subagents/pending-claim.ts).
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
		reviewTimedOut: "auto mode's review of this agent's actions did not finish before the report was delivered",
	};
};

/** The words for this session's tools and the profile's clauses. */
export const subagentResultText = wordsInForce("subagents", subagentResultWords);
