/**
 * spinner extension — Claude Code's live-activity chrome around the prompt:
 *
 * - The working line: pi's spinner becomes CC's animated asterisk (✳ frame
 *   cycle) with a random gerund verb per turn and live stats — "Hyperspacing…
 *   (10s · ↓ 448 tokens)" — updated on a 1s ticker while the model streams.
 *   Tokens are CC's estimate (streamed characters / 4).
 * - The context token counter: a right-aligned dim `58197 tokens` directly
 *   above the input box, refreshed whenever usage becomes known.
 *
 * Both matched to a frame capture of CC 2.1.233. CC's glimmer animation and
 * rotating tip lines are deliberately not replicated (pi renders the working
 * message as plain text, and tips carry CC's own frequency machinery).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dimRightAlignedWidget, safeThemePaint } from "../lib/tui-render.ts";
import { composeWorkingMessage, contextTokensText, messageChars, spinnerFrames } from "./line.ts";
import { pickVerb } from "./verbs.ts";

const COUNTER_KEY = "cc-context-tokens";
const FRAME_INTERVAL_MS = 120;
const TICK_MS = 1000;

export default function spinnerExtension(pi: ExtensionAPI) {
	let lastCtx: ExtensionContext | undefined;
	let verb = pickVerb();
	let turnStartedAt = 0;
	/** Characters from finished assistant messages this turn. */
	let settledChars = 0;
	/**
	 * The streaming message, summed lazily on the 1s ticker — message_update
	 * fires per token carrying the whole message-so-far, so counting there
	 * would be O(n²) over a long response.
	 */
	let streamingMessage: unknown;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const updateWorkingMessage = () => {
		const ctx = lastCtx;
		if (!ctx?.hasUI || !turnStartedAt) return;
		ctx.ui.setWorkingMessage(
			composeWorkingMessage({
				verb,
				elapsedMs: Date.now() - turnStartedAt,
				responseChars: settledChars + messageChars(streamingMessage),
			}),
		);
	};

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	const updateCounter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const text = contextTokensText(ctx.getContextUsage()?.tokens);
		ctx.ui.setWidget(COUNTER_KEY, dimRightAlignedWidget(text), { placement: "aboveEditor" });
	};

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		const paint = safeThemePaint(ctx.ui.theme);
		ctx.ui.setWorkingIndicator({
			frames: spinnerFrames(process.platform, process.env.TERM).map((frame) => paint("accent", frame)),
			intervalMs: FRAME_INTERVAL_MS,
		});
		updateCounter(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		verb = pickVerb();
		turnStartedAt = Date.now();
		settledChars = 0;
		streamingMessage = undefined;
		updateWorkingMessage();
		stopTicker();
		ticker = setInterval(updateWorkingMessage, TICK_MS);
		ticker.unref?.();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		streamingMessage = event.message;
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			settledChars += messageChars(event.message);
			streamingMessage = undefined;
		}
		// Usage (and so context size) lands with each finished message.
		updateCounter(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopTicker();
		turnStartedAt = 0;
		if (ctx.hasUI) ctx.ui.setWorkingMessage(); // restore pi's default for non-turn work
		updateCounter(ctx);
	});

	pi.on("session_shutdown", () => {
		stopTicker();
	});
}
