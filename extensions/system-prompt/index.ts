/**
 * system-prompt extension — replaces pi's default system prompt with the
 * adapted Claude Code prompt on every turn via before_agent_start.
 *
 * The environment block is cached per (cwd, model) so the generated prompt is
 * byte-stable across turns and provider prompt caching stays effective. The
 * scratchpad path embeds the session id, so it lives outside that cache —
 * derived at session_start, constant within the session.
 */

import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveModelTier } from "../lib/model-tier.ts";
import { sessionScratchpadDir } from "../lib/scratchpad.ts";
import { collectEnvironment, type EnvironmentInfo } from "./environment.ts";
import { collectGitStatus } from "./git-status.ts";
import { buildClaudeCodeSystemPrompt } from "./template.ts";

export default function systemPromptExtension(pi: ExtensionAPI) {
	let cachedEnv: EnvironmentInfo | undefined;
	let cachedKey = "";
	let scratchpad: string | undefined;
	// Claude Code's git snapshot is taken once "at the start of the conversation"
	// and never updated. Compute it here (fast, synchronous git calls) so it is a
	// true per-session snapshot that resets on /clear (session_start re-fires) and
	// stays constant across turns, keeping the system prompt cache-stable.
	let gitStatus: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		// The prompt section promises a usable directory, so the extension that
		// makes the promise creates it. Failure (unwritable /tmp) drops the
		// section rather than promising a directory writes will error on.
		const candidate = sessionScratchpadDir(ctx.cwd, ctx.sessionManager.getSessionId());
		try {
			mkdirSync(candidate, { recursive: true });
			scratchpad = candidate;
		} catch {
			scratchpad = undefined;
		}

		gitStatus = collectGitStatus(ctx.cwd);
	});

	pi.on("before_agent_start", (event, ctx) => {
		// A named agent (or a `--system-prompt` launch) supplies its own prompt via
		// customPrompt. Return nothing so pi's own builder uses it verbatim, rather
		// than clobbering it with the tiered One Code prompt.
		if (event.systemPromptOptions.customPrompt) return;

		const model = ctx.model;
		const modelLine = model ? `${model.id} (${model.provider})` : "unknown";
		// Re-resolved every turn: the model (and so the tier) can change mid-session.
		const tier = resolveModelTier(model);
		const key = `${ctx.cwd}|${modelLine}|${tier}`;
		if (!cachedEnv || cachedKey !== key) {
			cachedEnv = collectEnvironment(ctx.cwd, modelLine);
			cachedKey = key;
		}

		return {
			systemPrompt: buildClaudeCodeSystemPrompt(event.systemPromptOptions, cachedEnv, tier, scratchpad, gitStatus),
		};
	});
}
