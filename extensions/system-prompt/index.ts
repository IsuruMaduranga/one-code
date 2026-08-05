/**
 * system-prompt extension — replaces pi's default system prompt with the
 * adapted Claude Code prompt on every turn via before_agent_start.
 *
 * The environment block is cached per (cwd, model) so the generated prompt is
 * byte-stable across turns and provider prompt caching stays effective.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectEnvironment, type EnvironmentInfo } from "./environment.ts";
import { buildClaudeCodeSystemPrompt } from "./template.ts";

export default function systemPromptExtension(pi: ExtensionAPI) {
	let cachedEnv: EnvironmentInfo | undefined;
	let cachedKey = "";

	pi.on("before_agent_start", (event, ctx) => {
		const model = ctx.model;
		const modelLine = model ? `${model.id} (${model.provider})` : "unknown";
		const key = `${ctx.cwd}|${modelLine}`;
		if (!cachedEnv || cachedKey !== key) {
			cachedEnv = collectEnvironment(ctx.cwd, modelLine);
			cachedKey = key;
		}

		return { systemPrompt: buildClaudeCodeSystemPrompt(event.systemPromptOptions, cachedEnv) };
	});
}
