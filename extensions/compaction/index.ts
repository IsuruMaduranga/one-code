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
 * Not every compaction can replay — `fit.ts` explains when and why the
 * standalone shape (the doomed span alone, trimmed to the window) is used.
 *
 * Any failure returns nothing, so pi's own compaction serves — a different
 * summary style, never a broken compaction. CC_COMPACTION=0 opts out.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type AnthropicModelCompat,
	anthropicBetas,
	clearThinkingApplies,
	clearThinkingEnabled,
	isAnthropicOAuth,
	withClearThinking,
} from "../context-management/index.ts";
import { looksLikeAnthropicRequest } from "../lib/anthropic-payload.ts";
import { forcedReasoningLevel } from "../lib/model-policy.ts";
import { fitToBudget, replayFits, withoutUsage } from "./fit.ts";
import { buildCompactionInstruction, COMPACTION_MAX_TOKENS, continuationSummary, extractSummary } from "./prompt.ts";

/** Compaction reads a whole context window; give it more room than the classifier's 30s. */
const COMPACTION_TIMEOUT_MS = 120_000;

/**
 * The system prompt of a standalone (non-replay) request. The session's own is
 * left out along with the tools: neither helps a request that cannot hit the
 * cache, and together they cost ~20k tokens the doomed span needs on an overflow.
 */
export const STANDALONE_SYSTEM_PROMPT =
	"You are the coding assistant from the conversation below, asked to summarize it so work can continue in a fresh context. Respond with text only.";

type Preparation = Pick<SessionBeforeCompactEvent["preparation"], "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary">;

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
	 * standalone path) diverges at message one, because those injected reminders
	 * never become entries — so it cannot reproduce the cached prefix at all.
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
	// After a compaction the capture describes the pre-compaction request. A
	// second /compact before any turn would otherwise re-summarize history the
	// first one already folded away (and mis-scope the kept tail); the standalone
	// reconstruction from entries serves until the next request recaptures.
	pi.on("session_compact", () => {
		capturedMessages = undefined;
	});
	// A /tree branch switch stays in the same process and fires no `context`
	// event (navigateTree rebuilds the messages itself), so the capture would
	// still describe the abandoned branch — and a /compact before the next turn
	// summarized work the kept branch never did (review H1). Same remedy.
	pi.on("session_tree", () => {
		capturedMessages = undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (process.env.CC_COMPACTION === "0") return undefined;

		const model = ctx.model;
		if (!model) return undefined;
		// Snapshot before the first await so the capture and pi's preparation
		// describe the same request even if a context event lands meanwhile.
		const captured = capturedMessages;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			const baseUrl = (auth as { baseUrl?: string }).baseUrl;

			const maxTokens = Math.min(COMPACTION_MAX_TOKENS, model.maxTokens || COMPACTION_MAX_TOKENS);

			// Prefer the captured request prefix — it is cache-aligned and already
			// carries the leading compactionSummary message on a re-compaction — as
			// long as pi's max_tokens clamp leaves it room for the reply (fit.ts).
			// Otherwise (no capture yet, an overflow, a nearly full window) the
			// standalone shape summarizes the doomed span pi isolated. An overflow
			// never replays, so its replay request is not even built.
			const replay = captured && event.reason !== "overflow" ? replayRequest(pi, ctx, captured, event) : undefined;
			const request =
				replay && replayFits(event.reason, model, replay, maxTokens)
					? replay
					: standaloneRequest(
							model,
							event.preparation,
							buildCompactionInstruction({ reason: event.reason, customInstructions: event.customInstructions }),
							maxTokens,
						);

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
			const result = await completeSimple(baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model, request, {
				apiKey: auth.apiKey,
				headers,
				env: auth.env,
				signal: AbortSignal.any([event.signal, timeout]),
				maxTokens,
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
				// "off" carries no reasoning (matching what such a session sends) —
				// unless the model cannot disable thinking, where an off-request
				// would 400 (forcedReasoningLevel sends its lowest level instead).
				reasoning: ctx.thinkingLevel === "off" ? forcedReasoningLevel(model) : ctx.thinkingLevel,
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
			});

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
 * The cache-aligned shape: the session's system prompt, the active tool
 * definitions in their active order — kept purely so the cached prefix (tools
 * come first) still matches; a mismatch costs cache hits, never correctness —
 * the captured request verbatim, and the instruction as one more user message.
 *
 * pi keeps the tail after the cut point verbatim (keepRecentTokens, ~20k
 * tokens); the captured request still carries that tail, so the instruction
 * names it (`keptTailOf`). Cutting the tail off the request instead was
 * rejected: Anthropic checks cache hits only ~20 blocks back from the
 * breakpoint, so a request ending well before the last cached block misses
 * the cache the whole replay exists to hit.
 */
function replayRequest(pi: ExtensionAPI, ctx: ExtensionContext, captured: AgentMessage[], event: SessionBeforeCompactEvent): Context {
	const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const tools = pi
		.getActiveTools()
		.map((name) => byName.get(name))
		.filter((tool) => tool !== undefined)
		.map(({ name, description, parameters }) => ({ name, description, parameters }) as Tool);
	const instruction = buildCompactionInstruction({
		reason: event.reason,
		customInstructions: event.customInstructions,
		keptTail: keptTailOf(captured, event.preparation),
	});
	return { systemPrompt: ctx.getSystemPrompt(), messages: [...convertToLlm(captured), instructionMessage(instruction)], tools };
}

/**
 * The standalone shape: the doomed span reconstructed from session entries,
 * its assistant usage zeroed and its largest tool results cleared until pi's
 * clamp leaves room for the summary (`fit.ts`), no tools, a one-line system
 * prompt. Gets no kept-tail note: it holds only the doomed span. If it fails,
 * pi's own compaction serves. Exported for the unit test.
 */
export function standaloneRequest(model: Model<Api>, preparation: Preparation, instruction: string, maxTokens: number): Context {
	const messages = [...withoutUsage(convertToLlm(reconstructFromEntries(preparation))), instructionMessage(instruction)];
	return fitToBudget(model, { systemPrompt: STANDALONE_SYSTEM_PROMPT, messages }, maxTokens).request;
}

const instructionMessage = (instruction: string): Message => ({ role: "user", content: instruction, timestamp: Date.now() });

/**
 * The verbatim-kept tail of the captured request: everything after the doomed
 * span. pi builds the context as `[compactionSummary?] + one message per entry`
 * (`sessionEntryToContextMessages`) and `prepareCompaction` derives
 * `messagesToSummarize`/`turnPrefixMessages` with the same mapping, so the
 * doomed span is a prefix of the captured array. Alignment is checked role by
 * role; on any mismatch (an extension that inserted a message) no note is made
 * rather than a wrong one. Exported for the unit test.
 */
export function keptTailOf(
	captured: readonly { role: string; content?: unknown }[],
	preparation: Preparation,
): { count: number; opening?: string } | undefined {
	const doomed: { role: string }[] = [
		...(preparation.previousSummary ? [{ role: "compactionSummary" }] : []),
		...preparation.messagesToSummarize,
		...(preparation.isSplitTurn ? preparation.turnPrefixMessages : []),
	];
	if (doomed.length === 0 || doomed.length > captured.length) return undefined;
	for (let i = 0; i < doomed.length; i++) {
		if (captured[i].role !== doomed[i].role) return undefined;
	}
	const count = captured.length - doomed.length;
	if (count === 0) return { count };
	return { count, opening: openingText(captured[doomed.length]) };
}

/** The first ~80 characters of a message's text, single-line, for the landmark quote. */
function openingText(message: { content?: unknown }): string | undefined {
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? (content.find((b) => b && typeof b === "object" && (b as { type?: string }).type === "text") as { text?: string } | undefined)?.text
				: undefined;
	if (!text) return undefined;
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * The doomed span as messages, from session entries — the standalone path's
 * input.
 *
 * A previous compaction's summary is excluded from messagesToSummarize
 * (prepareCompaction starts after that entry), yet the live context carries it
 * as its leading compactionSummary message. Reattach it in exactly that shape so
 * convertToLlm renders the same bytes the session's context holds. A split
 * turn's discarded prefix has no separate summary on this path, so it is
 * summarized with the rest.
 */
function reconstructFromEntries(preparation: Preparation): AgentMessage[] {
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
