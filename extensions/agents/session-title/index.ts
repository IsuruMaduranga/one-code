/**
 * session-title extension — Claude Code's automatic session name.
 *
 * CC names every session once, from the first real user message, with one
 * small-model call (`utils/sessionTitle.ts` `generateSessionTitle`; the 2.1.278
 * request is `captures/session_name.json` — findings §14), and shows the name
 * in the terminal title and the session list. pi has the slot for it —
 * `pi.setSessionName()`, what `/name` sets: the session picker shows it instead
 * of the first message, and `session_info_changed` lets the branding extension
 * retitle the terminal — but never fills it by itself.
 *
 * Shape (the profile holds the strings, text.ts): the cheapest capable contained model
 * (pickEconomicalContainedModel — CC's Haiku analog, the same pick the recap
 * makes), CC's naming instruction as the system prompt, the first prose
 * wrapped in `<session>` tags, no tools, thinking off, ~a line of output.
 * Fire-and-forget: the turn never waits for it, a failure names nothing and
 * does not retry (CC retries on the next message when Haiku returns nothing;
 * here one attempt per session keeps a broken provider from being hit on
 * every prompt), and a user's own `/name` is never overwritten. Skipped in
 * one-shot modes (`-p`, `--mode json`: the process exits at settle, a title
 * has nowhere to show) and with the `session-title` feature off.
 */

import { feature } from "../../lib/profile/feature.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withReasoningFallback } from "../../lib/models/model-policy.ts";
import { pickEconomicalContainedModel } from "../../lib/models/model-tier.ts";
import { sessionOutlivesTurn } from "../../lib/notify/notifications.ts";
import { isUserRun } from "../../lib/ui/prompt-options.ts";
import { recordUsage } from "../../lib/notify/usage-bus.ts";
import { requireText } from "../../lib/profile/profile.ts";
import { firstUserText, isNameableText, parseTitle, sessionTitleInput } from "./title.ts";

const TITLE_MAX_TOKENS = 128; // a noun phrase, with room for a JSON wrapper
const TITLE_TIMEOUT_MS = 30_000;

function sessionTitleExtension(pi: ExtensionAPI) {
	const words = requireText("sessionTitle");
	/** One attempt per session, like CC's `haikuTitleAttemptedRef`. */
	let attempted = false;
	let inFlight: AbortController | undefined;

	const reset = () => {
		attempted = false;
		inFlight?.abort();
		inFlight = undefined;
	};

	// A new session (startup, /clear, a resume, a /tree switch) is a new
	// naming opportunity; an in-flight request belonged to the old one.
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);

	pi.on("before_agent_start", (event, ctx) => {
		if (attempted) return;
		if (!sessionOutlivesTurn(ctx.mode)) return;
		if (pi.getSessionName()) {
			attempted = true; // the user (or a resume) named it already
			return;
		}
		// CC names after the FIRST user message; on a fresh session that is the
		// prompt being submitted (not yet in the entries when this fires). That
		// message never changes, so it is examined once: a first message that is
		// not prose (a breadcrumb, a slash command sent as text) leaves the
		// session unnamed rather than re-scanning the entries every turn.
		// A run an extension opened (pi 1.2.0) carries no prompt: wait for the user's.
		if (!isUserRun(event)) return;
		attempted = true;
		const text = firstUserText(ctx.sessionManager.getEntries() as never) ?? event.prompt;
		if (!isNameableText(text)) return;
		void generate(text, ctx);
	});

	async function generate(text: string, ctx: ExtensionContext) {
		const controller = new AbortController();
		inFlight = controller;
		try {
			const model = ctx.model;
			if (!model) return;
			const choice = pickEconomicalContainedModel(ctx.modelRegistry.getAvailable(), model);
			if (!choice) return;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
			if (!auth.ok) return;
			const baseUrl = (auth as { baseUrl?: string }).baseUrl;
			const result = await withReasoningFallback(
				choice.model,
				(reasoning) => {
					const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
					return completeSimple(
						baseUrl ? ({ ...choice.model, baseUrl } as Model<Api>) : choice.model,
						{
							systemPrompt: words.system,
							messages: [{ role: "user", content: sessionTitleInput(words, text), timestamp: Date.now() }],
							tools: [],
						},
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							env: auth.env,
							signal: AbortSignal.any([controller.signal, timeout]),
							maxTokens: TITLE_MAX_TOKENS,
							...(reasoning ? { reasoning } : {}),
						},
					);
				},
				undefined,
				(usage) => recordUsage(pi, "session-title", usage),
			);
			if (controller.signal.aborted) return;
			const reply = result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const title = parseTitle(reply);
			// The user may have typed /name while the request was out; theirs wins.
			if (!title || pi.getSessionName()) return;
			pi.setSessionName(title);
		} catch {
			// Best-effort, like CC: an unnamed session is the only consequence.
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	}
}

export default feature("session-title", sessionTitleExtension);
