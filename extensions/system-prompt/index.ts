/**
 * system-prompt extension — replaces pi's default system prompt with the
 * adapted Claude Code prompt on every turn via before_agent_start, and on a
 * turn opened from idle (which skips that hook) via context_with_system
 * (idle-turn.ts).
 *
 * The environment block is cached per (cwd, model) so the generated prompt is
 * byte-stable across turns and provider prompt caching stays effective. The
 * scratchpad path embeds the session id, so it lives outside that cache —
 * derived at session_start, constant within the session.
 */

import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelTier, taskToolsEnabled } from "../lib/model-tier.ts";
import { privateSessionScratchpadDir } from "../lib/scratchpad.ts";
import { collectEnvironment, type EnvironmentInfo } from "./environment.ts";
import { collectGitStatus } from "./git-status.ts";
import { totalTokensBlock, turnTokenBudget } from "../context-budget/budget.ts";
import { optionsForIdleTurn, withSystemHead } from "./idle-turn.ts";
import { buildClaudeCodeSystemPrompt } from "./template.ts";
import { WORKSPACE_CHANNEL, type WorkspaceAnnouncement } from "../lib/workspace-channel.ts";
import { PROMPT_OPTIONS_CHANNEL, type PromptOptionsAnnouncement, SYSTEM_PROMPT_REQUEST_CHANNEL, type SystemPromptRequest } from "../lib/prompt-options.ts";

export default function systemPromptExtension(pi: ExtensionAPI) {
	let cachedEnv: EnvironmentInfo | undefined;
	let cachedKey = "";
	let scratchpad: string | undefined;
	// Claude Code's git snapshot is taken once "at the start of the conversation"
	// and never updated. It is computed lazily on the first turn (memoized) rather
	// than in session_start, so its several synchronous git spawns never delay the
	// prompt opening (findings §15); it resets on /clear (session_start re-fires)
	// and stays constant across turns, keeping the system prompt cache-stable.
	let gitStatus: string | null = null;
	let gitStatusReady = false;
	// The workspace directories as the session started. The permissions
	// extension announces them from its own session_start, which runs before
	// this one (load order), so this handler does not reset them.
	let workspaceDirs: string[] = [];
	/** The options the last before_agent_start saw; a turn opened from idle rebuilds from them. */
	let lastOptions: BuildSystemPromptOptions | undefined;
	pi.events.on(WORKSPACE_CHANNEL, (data) => {
		const dirs = (data as WorkspaceAnnouncement | undefined)?.dirs;
		workspaceDirs = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : [];
	});

	pi.on("session_start", (_event, ctx) => {
		// The prompt section promises a usable directory, so the extension that
		// makes the promise creates it. Failure (unwritable /tmp) drops the
		// section rather than promising a directory writes will error on.
		// On a shared /tmp it must also be private to this user
		// (lib/scratchpad.ts ensurePrivateScratchpad); otherwise the section is dropped.
		scratchpad = privateSessionScratchpadDir(ctx.cwd, ctx.sessionManager.getSessionId());

		gitStatus = null;
		gitStatusReady = false;
		// Another session's options (a named agent's customPrompt, its tool set)
		// must not shape this one's idle turns.
		lastOptions = undefined;
	});

	const buildPrompt = (options: BuildSystemPromptOptions, ctx: ExtensionContext): string => {
		if (!gitStatusReady) {
			// First turn = the conversation start CC snapshots at. The clip note
			// names the shell tool the model has (PowerShell only without bash).
			const tools = options.selectedTools ?? [];
			const shellTool = tools.includes("powershell") && !tools.includes("bash") ? "powershell" : "bash";
			gitStatus = collectGitStatus(ctx.cwd, undefined, shellTool);
			gitStatusReady = true;
		}

		const model = ctx.model;
		const modelLine = model ? `${model.id} (${model.provider})` : "unknown";
		// Re-resolved every turn: the model (and so the tier) can change mid-session.
		const tier = resolveModelTier(model);
		const key = `${ctx.cwd}|${modelLine}|${tier}`;
		if (!cachedEnv || cachedKey !== key) {
			cachedEnv = collectEnvironment(ctx.cwd, modelLine);
			cachedKey = key;
		}

		// The same constant the context-budget extension puts on every user message.
		const totalTokensLine = process.env.CC_TOTAL_TOKENS === "0" ? null : totalTokensBlock(turnTokenBudget());
		return buildClaudeCodeSystemPrompt(
			options,
			{ ...cachedEnv, workspaceDirs },
			tier,
			scratchpad,
			gitStatus,
			totalTokensLine,
			taskToolsEnabled(model, process.env, tier),
		);
	};

	// A copy: pi goes on mutating this object after the handlers return
	// (forceSystemPrompt, the live selectedTools).
	const copyOptions = (options: BuildSystemPromptOptions): BuildSystemPromptOptions => ({
		...options,
		selectedTools: options.selectedTools && [...options.selectedTools],
	});

	// A command that starts background work before any prompt announces pi's
	// options (lib/prompt-options.ts), so the turn its completion opens is built
	// like a typed one. A typed prompt's own options always win.
	pi.events.on(PROMPT_OPTIONS_CHANNEL, (data) => {
		const options = (data as PromptOptionsAnnouncement | undefined)?.options;
		if (!lastOptions && options && typeof options === "object") lastOptions = copyOptions(options as BuildSystemPromptOptions);
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastOptions = copyOptions(event.systemPromptOptions);
		// A named agent (or a `--system-prompt` launch) supplies its own prompt via
		// customPrompt. Return nothing so pi's own builder uses it verbatim, rather
		// than clobbering it with the tiered One Code prompt.
		if (event.systemPromptOptions.customPrompt) return;
		return { systemPrompt: buildPrompt(event.systemPromptOptions, ctx) };
	});

	// A turn opened from idle (a cron tick, a background completion) skips
	// before_agent_start and would run on pi's default prompt (idle-turn.ts).
	// In a prompt() run pi's forced-prompt projection runs after this and
	// installs the same text, so the head is rebuilt on every request.
	/** The prompt the session's next request carries; undefined when pi's own builder supplies it. */
	const nextRequestPrompt = (ctx: ExtensionContext): string | undefined =>
		!lastOptions || lastOptions.customPrompt ? undefined : buildPrompt(optionsForIdleTurn(lastOptions, pi.getActiveTools()), ctx);

	pi.on("context_with_system", (event, ctx) => {
		const prompt = nextRequestPrompt(ctx);
		if (prompt === undefined) return;
		return { messages: withSystemHead(event.messages, prompt, getCurrentSystemMessage(event.messages)) };
	});

	// A fork inherits this prompt, not pi's (lib/prompt-options.ts).
	pi.events.on(SYSTEM_PROMPT_REQUEST_CHANNEL, (data) => {
		const request = data as SystemPromptRequest;
		const prompt = nextRequestPrompt(request.ctx as ExtensionContext);
		if (prompt !== undefined) request.prompt = prompt;
	});
}
