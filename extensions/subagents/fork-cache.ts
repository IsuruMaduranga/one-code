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
 *   with the captured body (`forkRequestPayload`).
 *
 * Both steps check the same thing first (the capture's model and its boundary
 * message in this context); when either fails, the request goes out the
 * ordinary way, whole, and uncached. That happens only for a fork that
 * compacted its own history away or runs on another model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureMatches, forkRequestPayload, type RequestCapture, toolNames, uncoveredMessages } from "../lib/request-replay.ts";

type ModelRef = { api?: string; provider?: string; id?: string };

export function forkCacheExtension(capture: RequestCapture) {
	return (pi: ExtensionAPI) => {
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
			shaped = true;
			return { messages: tail as typeof event.messages };
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
