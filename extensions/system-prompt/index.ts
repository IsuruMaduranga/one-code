/**
 * system-prompt extension — replaces pi's default system prompt with the
 * adapted Claude Code prompt on every turn via before_agent_start, and on a
 * turn opened from idle (which skips that hook) via context_with_system
 * (idle-turn.ts).
 *
 * The environment facts are cached per cwd so the generated text is
 * byte-stable across turns and provider prompt caching stays effective.
 * Claude Code's `# Environment` block and model line are not in the prompt:
 * this extension queues them as the first two first-message context blocks,
 * which a model that takes a mid-conversation system message gets there
 * instead (system-reminder). The scratchpad path the block names embeds the
 * session id — derived at session_start, constant within the session.
 */

import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { environmentBlock, modelLine } from "../lib/environment-block.ts";
import { GIT_SNAPSHOT_OWNER_CHANNEL } from "../lib/git-status.ts";
import { oneShotSessionNote, sessionOutlivesTurn } from "../lib/notifications.ts";
import { resolveModelTier, taskToolsEnabled } from "../lib/model-tier.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { privateSessionScratchpadDir } from "../lib/scratchpad.ts";
import { collectEnvironment, type EnvironmentInfo } from "./environment.ts";
import { totalTokensBlock, turnTokenBudget } from "../context-budget/budget.ts";
import { optionsForIdleTurn, withSystemHead } from "./idle-turn.ts";
import { buildClaudeCodeSystemPrompt } from "./template.ts";
import { WORKSPACE_CHANNEL, type WorkspaceAnnouncement } from "../lib/workspace-channel.ts";
import { PROMPT_OPTIONS_CHANNEL, type PromptOptionsAnnouncement, SYSTEM_PROMPT_REQUEST_CHANNEL, type SystemPromptRequest } from "../lib/prompt-options.ts";

export default function systemPromptExtension(pi: ExtensionAPI) {
	let cachedEnv: EnvironmentInfo | undefined;
	let cachedKey = "";
	let scratchpad: string | undefined;
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
		// The environment block's scratchpad line promises a usable directory, so
		// the extension that makes the promise creates it. Failure (unwritable
		// /tmp) drops the line rather than promising a directory writes will error
		// on. On a shared /tmp it must also be private to this user
		// (lib/scratchpad.ts ensurePrivateScratchpad); otherwise the line is dropped.
		scratchpad = privateSessionScratchpadDir(ctx.cwd, ctx.sessionManager.getSessionId());
		// The main session's context block carries Claude Code's git snapshot (claude-context).
		pi.events.emit(GIT_SNAPSHOT_OWNER_CHANNEL, {});

		// Another session's options (a named agent's customPrompt, its tool set)
		// must not shape this one's idle turns.
		lastOptions = undefined;
	});

	const environment = (cwd: string): EnvironmentInfo => {
		if (!cachedEnv || cachedKey !== cwd) {
			cachedEnv = collectEnvironment(cwd);
			cachedKey = cwd;
		}
		return cachedEnv;
	};

	const buildPrompt = (options: BuildSystemPromptOptions, ctx: ExtensionContext): string => {
		const model = ctx.model;
		// Re-resolved every turn: the model (and so the tier) can change mid-session.
		const tier = resolveModelTier(model);
		// The same constant the context-budget extension puts on every user message.
		const totalTokensLine = process.env.CC_TOTAL_TOKENS === "0" ? null : totalTokensBlock(turnTokenBudget());
		return buildClaudeCodeSystemPrompt(options, environment(ctx.cwd), tier, totalTokensLine, taskToolsEnabled(model, process.env, tier));
	};

	// Claude Code's environment block and model line, the first two blocks of the
	// first-message context, on every turn (a named agent's own prompt gets
	// neither, as before). Re-queued per turn under
	// fixed keys, so the text changes only when the facts do: a model switch
	// changes the model line, and the new model reads its own cache anyway.
	pi.on("turn_start", (_event, ctx) => {
		// A first turn opened from idle has no options yet and still gets them, so
		// message 1 never gains them later.
		if (lastOptions?.customPrompt) return;
		const env = environment(ctx.cwd);
		pi.events.emit(REMINDER_CHANNEL, {
			text: environmentBlock({ ...env, scratchpadDir: scratchpad, workspaceDirs }),
			scope: "every-turn",
			key: "environment",
			placement: "first-prepend",
			order: CONTEXT_ORDER.environment,
		});
		if (!sessionOutlivesTurn(ctx.mode)) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: oneShotSessionNote(),
				scope: "every-turn",
				key: "one-shot",
				placement: "first-prepend",
				order: CONTEXT_ORDER.oneShot,
			});
		}
		if (ctx.model) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: modelLine(ctx.model),
				scope: "every-turn",
				key: "model-line",
				placement: "first-prepend",
				order: CONTEXT_ORDER.modelLine,
			});
		}
	});

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
