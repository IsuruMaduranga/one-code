/**
 * compaction extension — replaces pi's summarizer with Claude Code's.
 *
 * Hooks `session_before_compact` (manual /compact, threshold, and overflow
 * alike), reuses pi's already-computed cut point, and sends Claude Code's
 * compaction instruction; only the <summary> block of the reply survives as
 * context.
 *
 * The call is built to hit the provider prompt cache, which is why Claude
 * Code compacts on the *session model* rather than something cheaper: it
 * keeps the session's system prompt, tools, and message prefix intact and
 * merely appends the instruction, so the summarization call is mostly cache
 * reads. Same here — session model, session system prompt, the active tool
 * definitions, and the doomed messages natively (via pi's convertToLlm,
 * since pi's extended AgentMessage kinds don't survive the wire shape), with
 * the instruction riding as a final user message of <system-reminder> blocks.
 *
 * Deliberate fidelity gap: Claude Code runs the call with extended thinking;
 * `reasoning` is not sent here because it fails *closed* on providers pi's
 * compat data mispredicts — the same trade the classifier documents.
 *
 * Any failure returns nothing, so pi's own compaction serves — a different
 * summary style, never a broken compaction. CC_COMPACTION=0 opts out.
 */

import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompactionInstruction, COMPACTION_MAX_TOKENS, continuationSummary, extractSummary } from "./prompt.ts";

/** Compaction reads a whole context window; give it more room than the classifier's 30s. */
const COMPACTION_TIMEOUT_MS = 120_000;

export default function compactionExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		if (process.env.CC_COMPACTION === "0") return undefined;

		const model = ctx.model;
		if (!model) return undefined;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			const baseUrl = (auth as { baseUrl?: string }).baseUrl;

			const preparation = event.preparation;
			// A split turn's prefix is being discarded too; it has no separate
			// summary on the extension path, so it is summarized with the rest.
			const doomed = preparation.isSplitTurn
				? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
				: preparation.messagesToSummarize;

			/**
			 * A previous compaction's summary is excluded from messagesToSummarize
			 * (prepareCompaction starts after that entry), yet the live context
			 * carries it as its leading compactionSummary message. Reattach it in
			 * exactly that shape so convertToLlm renders the same bytes the
			 * session's cached prefix holds — re-compactions stay cache reads too —
			 * and the summarizer sees it the way the model has all along.
			 * tokensBefore/timestamp never reach the wire.
			 */
			const messages = preparation.previousSummary
				? [
						{
							role: "compactionSummary",
							summary: preparation.previousSummary,
							tokensBefore: 0,
							timestamp: Date.now(),
						} as Parameters<typeof convertToLlm>[0][number],
						...doomed,
					]
				: doomed;

			const instruction = buildCompactionInstruction({
				reason: event.reason,
				customInstructions: event.customInstructions,
			});

			// The active tool definitions, in their active order — kept in the
			// request purely so the cached prefix (tools come first) still matches.
			// A mismatch costs cache hits, never correctness.
			const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const tools = pi
				.getActiveTools()
				.map((name) => byName.get(name))
				.filter((tool) => tool !== undefined)
				.map(({ name, description, parameters }) => ({ name, description, parameters }) as Tool);

			const timeout = AbortSignal.timeout(COMPACTION_TIMEOUT_MS);
			const result = await completeSimple(
				baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model,
				{
					systemPrompt: ctx.getSystemPrompt(),
					messages: [...convertToLlm(messages), { role: "user", content: instruction, timestamp: Date.now() }],
					tools,
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: AbortSignal.any([event.signal, timeout]),
					maxTokens: Math.min(COMPACTION_MAX_TOKENS, model.maxTokens || COMPACTION_MAX_TOKENS),
					// The session id is the prompt-cache key / routing affinity on the
					// providers that use one (openai-codex prompt_cache_key, session
					// headers). Without it the replayed prefix cannot hit the session's
					// cache no matter how well the bytes match.
					sessionId: ctx.sessionManager.getSessionId(),
				},
			);

			const text = result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const summary = extractSummary(text);
			if (!summary) return undefined;

			return {
				compaction: {
					// Undefined in --no-session runs; the pointer line is dropped.
					summary: continuationSummary(summary, ctx.sessionManager.getSessionFile()),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: result.usage,
				},
			};
		} catch {
			// pi's default compaction runs instead: degraded style, never broken.
			return undefined;
		}
	});
}
