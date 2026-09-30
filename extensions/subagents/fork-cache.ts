/**
 * The fork's side of reading the parent's prompt cache (decisions/caching.md,
 * "A call that inherits the session's context reads the session's cache").
 *
 * A fork's own session builds its requests from its own system prompt, tools
 * and reminder stack, so every fork re-read the parent's whole transcript
 * uncached: on a parent near a 1M-token window, the whole window per fork.
 * This inline extension, loaded last in a fork's session, sends the parent's
 * last captured request instead, with the fork's own messages after it:
 *
 * - `context_with_system` (it runs after every `context` handler, so the
 *   fork's reminder stack is already on the messages it drops) removes the
 *   messages the capture carries, leaving pi to convert only the fork's tail;
 * - `before_provider_request` (inline extensions load after the path ones, so
 *   tool-search has already edited the body) replaces everything but the tail
 *   with the captured body (`forkRequestPayload`);
 * - `before_provider_headers` sends the parent's session-affinity headers, so a
 *   gateway such as OpenRouter routes the fork to the host holding the cache.
 *
 * Both steps check the same thing first (the capture's model and its boundary
 * message in this context); when either fails, or the tail leaves less than
 * `MIN_REPLAY_OUTPUT_TOKENS` of the captured output room, the request goes out
 * the ordinary way, whole, and uncached. That happens only for a fork that
 * compacted its own history away, runs on another model, or has nearly
 * filled the window.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { type AffinityModel, affinityHeaders, captureMatches, forkOutputRoom, forkRequestPayload, MIN_REPLAY_OUTPUT_TOKENS, type RequestCapture, toolNames, uncoveredMessages } from "../lib/request-replay.ts";

type ModelRef = { api?: string; provider?: string; id?: string };

export function forkCacheExtension(capture: RequestCapture) {
	return (pi: ExtensionAPI) => {
		// The fork advertises the parent's tools, where SendMessage is deferred
		// (subagents/index.ts). Defer the fork's own SendMessage the same way, so a
		// tool_search load reaches it: on a model without tool references the load
		// appends it, and elsewhere the parent's compatible schema (to: "main")
		// already declares it. Inline extensions load after tool-search.
		pi.events.emit(DEFER_CHANNEL, { name: "SendMessage", keywords: ["message", "main", "report", "progress"] });
		/** Set by the context step for the request it shaped; the payload step splices only then. */
		let shaped = false;
		/** The tool names of the fork's first request: anything added later was loaded during the run. */
		let baseline: Set<string> | undefined;

		pi.on("context_with_system", (event, ctx) => {
			shaped = false;
			const covers = capture.covers;
			if (!covers || !captureMatches(capture, ctx.model as ModelRef | undefined)) return undefined;
			const tail = uncoveredMessages(event.messages as { role: string; timestamp?: number }[], covers);
			if (!tail) return undefined;
			// Too little output room left after the prefix: send the fork whole
			// (pi's overflow handling then compacts it) rather than a splice the
			// window cannot hold. The messages' JSON overstates the wire tail.
			const room = forkOutputRoom(capture, tail.filter((message) => message.role !== "system"));
			if (room !== undefined && room < MIN_REPLAY_OUTPUT_TOKENS) return undefined;
			shaped = true;
			return { messages: tail as typeof event.messages };
		});

		// Route to the parent's host: a gateway picks it by the session-affinity
		// headers, and the parent's cache lives there. Harmless on a whole request.
		pi.on("before_provider_headers", (event, ctx) => {
			if (!capture.sessionId || !captureMatches(capture, ctx.model as ModelRef | undefined)) return;
			Object.assign(event.headers, affinityHeaders(ctx.model as AffinityModel, capture.sessionId));
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!shaped || !captureMatches(capture, ctx.model as ModelRef | undefined)) return undefined;
			shaped = false;
			const payload = event.payload as Record<string, unknown>;
			baseline ??= new Set(toolNames(payload.tools));
			return forkRequestPayload(capture, payload, baseline);
		});
	};
}
