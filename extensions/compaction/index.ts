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
 * definitions, and, crucially, the session's *last actual request messages*
 * (captured from the `context` event, see below), with the instruction riding
 * as a final user message of <system-reminder> blocks.
 *
 * A cache hit needs the whole request to match the session's, so the call also
 * replays two request options the naive shape got wrong:
 *   - `reasoning`: mirrors the session's thinking level. On the Responses API the
 *     reasoning config is part of the prompt-cache identity — a byte-identical
 *     prefix still misses without it (measured). Safe where the classifier's
 *     cross-model reasoning trade is not: it is the session's own model, already
 *     proven to accept the level, and pi clamps an unsupported level down.
 *   - On Anthropic, the context-management beta + `clear_thinking` body edit that
 *     the session's requests carry (added by the context-management extension via
 *     hooks completeSimple bypasses). Without them the session caches its message
 *     prefix thinking-cleared while this call sends full thinking blocks, and the
 *     mismatch invalidates the message-block cache (system+tools still read).
 *
 * Any failure returns nothing, so pi's own compaction serves — a different
 * summary style, never a broken compaction. CC_COMPACTION=0 opts out.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type AnthropicModelCompat,
	anthropicBetas,
	clearThinkingApplies,
	clearThinkingEnabled,
	isAnthropicOAuth,
	looksLikeAnthropicRequest,
	withClearThinking,
} from "../context-management/index.ts";
import { buildCompactionInstruction, COMPACTION_MAX_TOKENS, continuationSummary, extractSummary } from "./prompt.ts";

/** Compaction reads a whole context window; give it more room than the classifier's 30s. */
const COMPACTION_TIMEOUT_MS = 120_000;

export default function compactionExtension(pi: ExtensionAPI) {
	/**
	 * The exact message array the session last handed the provider, captured
	 * from the `context` event AFTER every extension has mutated it — most
	 * importantly system-reminder, which injects <system-reminder> blocks at
	 * request time (memory index, the every-turn subagent-models reminder, …).
	 *
	 * Byte-matching the prefix is necessary for the cache but not sufficient (the
	 * `reasoning` and, on Anthropic, `clear_thinking` options below must match too).
	 * pi's agent loop builds a request by applying `transformContext` (this very
	 * event) and then `convertToLlm` (agent-loop.ts); we call the *same*
	 * `convertToLlm` on the captured array, so the message prefix we send is
	 * byte-identical to the turn's, and appending only the instruction keeps that
	 * whole prefix reusable. Reconstructing from session entries instead (the
	 * fallback) diverges at message one, because those injected reminders never
	 * become entries — so it cannot reproduce the cached prefix at all.
	 *
	 * We hold the reference, not a copy: `emitContext` hands each handler a fresh
	 * structuredClone the session never mutates again, and compaction is the
	 * last extension with a `context` handler, so this reference is exactly the
	 * array the turn sent. Returning nothing keeps the handler a pure observer.
	 */
	let capturedMessages: AgentMessage[] | undefined;
	pi.on("context", (event) => {
		capturedMessages = event.messages;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (process.env.CC_COMPACTION === "0") return undefined;

		const model = ctx.model;
		if (!model) return undefined;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			const baseUrl = (auth as { baseUrl?: string }).baseUrl;

			// Prefer the captured request prefix — it is cache-aligned and already
			// carries the leading compactionSummary message on a re-compaction.
			// Fall back to reconstructing from session entries only when nothing
			// has been captured yet (e.g. /compact as the first action in a freshly
			// resumed session, before any turn ran); that path cannot hit the cache.
			const messages = capturedMessages ?? reconstructFromEntries(event.preparation);

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

			// When context-management (clear_thinking) is active for this session,
			// the agent loop's cached message prefix has old thinking blocks cleared
			// and every request carries the context-management beta. completeSimple
			// bypasses our before_provider_headers/before_provider_request handlers,
			// so the compaction request would omit both — and on Anthropic that
			// mismatch invalidates the *message* cache (system+tools still read, but
			// the whole history re-caches; measured cacheRead ~13k of ~56k). Replay
			// the same beta header and clear_thinking body edit so the replayed
			// prefix matches the session's cache and the history stays a cache read.
			// No-op off Anthropic (clearThinkingEnabled is false there), where
			// automatic prefix caching needs neither.
			// model.compat is a provider union; the clear_thinking helpers only read
			// the Anthropic-shaped fields, and are gated to Anthropic anyway.
			const cmModel = model as { api?: string; provider?: string; baseUrl?: string; compat?: AnthropicModelCompat };
			const clearThinking = clearThinkingEnabled(process.env.CC_CLEAR_THINKING, cmModel);
			const headers = clearThinking
				? { ...auth.headers, "anthropic-beta": anthropicBetas(isAnthropicOAuth(), cmModel.compat) }
				: auth.headers;

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
					headers,
					env: auth.env,
					signal: AbortSignal.any([event.signal, timeout]),
					maxTokens: Math.min(COMPACTION_MAX_TOKENS, model.maxTokens || COMPACTION_MAX_TOKENS),
					// The session id is the prompt-cache key / routing affinity on the
					// providers that use one (openai-codex prompt_cache_key, session
					// headers). Without it the replayed prefix cannot hit the session's
					// cache no matter how well the bytes match.
					sessionId: ctx.sessionManager.getSessionId(),
					// Reasoning config is part of the cache identity on the Responses
					// API: with a byte-identical prefix, prompt_cache_key, tools, and
					// system prompt, omitting `reasoning` on a reasoning-configured
					// session still misses the cache entirely (measured: cacheRead 0).
					// Mirror the session's own thinking level so the request matches
					// the prefix the session cached. Unlike the auto-mode classifier —
					// which may run a *different*, unvalidated model where reasoning
					// fails closed — this is the session's own model, already proven to
					// accept this level, and streamSimple clamps an unsupported level
					// down rather than erroring, so mirroring never fails closed here.
					// "off" carries no reasoning (matching what such a session sends).
					reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
					// The clear_thinking body edit, matching the session's requests (see
					// the header note above). Only attached on Anthropic requests that
					// carry thinking, exactly as the context-management extension gates it.
					onPayload: clearThinking
						? (payload: unknown) =>
								looksLikeAnthropicRequest(payload) &&
								clearThinkingApplies(payload as Record<string, unknown>, cmModel.compat?.forceAdaptiveThinking === true)
									? withClearThinking(payload as Record<string, unknown>)
									: payload
						: undefined,
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
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: result.usage,
				},
			};
		} catch {
			// pi's default compaction runs instead: degraded style, never broken.
			return undefined;
		}
	});
}

/**
 * Fallback message construction from session entries, used only when no live
 * request was captured. This cannot hit the prompt cache (the request-time
 * <system-reminder> injections are absent from entries), but it still yields a
 * correct summary — and if it fails, pi's own compaction serves.
 *
 * A previous compaction's summary is excluded from messagesToSummarize
 * (prepareCompaction starts after that entry), yet the live context carries it
 * as its leading compactionSummary message. Reattach it in exactly that shape so
 * convertToLlm renders the same bytes the session's context holds. A split
 * turn's discarded prefix has no separate summary on this path, so it is
 * summarized with the rest.
 */
function reconstructFromEntries(preparation: SessionBeforeCompactEvent["preparation"]): AgentMessage[] {
	const doomed = preparation.isSplitTurn
		? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
		: preparation.messagesToSummarize;
	return preparation.previousSummary
		? [
				{
					role: "compactionSummary",
					summary: preparation.previousSummary,
					tokensBefore: 0,
					timestamp: Date.now(),
				} as AgentMessage,
				...doomed,
			]
		: doomed;
}
