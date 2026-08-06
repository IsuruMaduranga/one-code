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
import { sessionScratchpadDir } from "../lib/scratchpad.ts";
import { collectEnvironment, type EnvironmentInfo } from "./environment.ts";
import { buildClaudeCodeSystemPrompt } from "./template.ts";

export default function systemPromptExtension(pi: ExtensionAPI) {
	let cachedEnv: EnvironmentInfo | undefined;
	let cachedKey = "";
	let scratchpad: string | undefined;

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
	});

	pi.on("before_agent_start", (event, ctx) => {
		const model = ctx.model;
		const modelLine = model ? `${model.id} (${model.provider})` : "unknown";
		const key = `${ctx.cwd}|${modelLine}`;
		if (!cachedEnv || cachedKey !== key) {
			cachedEnv = collectEnvironment(ctx.cwd, modelLine);
			cachedKey = key;
		}

		return { systemPrompt: buildClaudeCodeSystemPrompt(event.systemPromptOptions, cachedEnv, scratchpad) };
	});
}
