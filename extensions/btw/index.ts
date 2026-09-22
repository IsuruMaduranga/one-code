/**
 * btw extension — Claude Code's `/btw` ("by the way") side question.
 *
 * `/btw <question>` asks a one-off question that is answered from the current
 * conversation's context while the main agent keeps working. CC frames the
 * answering model as a separate, lightweight, tool-less instance (the verbatim
 * reminder in prompt.ts, captured from CC 2.1.278) and shows the answer in a
 * focused overlay panel, not in the transcript — so the exchange never enters
 * the main agent's context and cannot steer its work.
 *
 * The call reuses recap's machinery: the exact messages the session last put on
 * the wire (captured from the `context` event), name-only tool stubs so a
 * history carrying tool_use blocks stays valid on strict providers, and
 * withReasoningFallback for models that cannot disable thinking. Unlike recap it
 * uses the SESSION model (not an economical one) — a side question deserves the
 * same quality as the main conversation — and sends the full captured history,
 * not just the recent window.
 *
 * Deviations from CC, logged in docs/decisions/btw.md: the exchange is stateless
 * (each `/btw` sees only the shared main context, never a prior `/btw` — CC
 * keeps a side-session; the "one-off, no follow-up" framing holds either way);
 * `f to fork` is omitted (pi's `ctx.fork` branches from a session entry, not
 * from an injected side exchange); and the call runs with an empty system prompt
 * (the `context` event carries no system prompt to reuse), relying on the shared
 * history plus the reminder.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withReasoningFallback } from "../lib/model-policy.ts";
import { answerText, stripImageBlocks, toolStubs, trimToTurnBoundary } from "../lib/side-call.ts";
import { boundedDockHeight, truncateLine } from "../lib/tui-render.ts";
import { recordUsage } from "../lib/usage-bus.ts";
import { applyBtwKey, type BtwBody, BTW_MAX_HEIGHT, decodeBtwKey, initialBtwState, renderBtwPanel } from "./panel.ts";
import { sideQuestionMessage } from "./prompt.ts";

const BTW_MAX_TOKENS = 8192;
const BTW_TIMEOUT_MS = 120_000;
/** Description on the name-only tool stubs sent with the side question. */
const STUB_REASON = "Unavailable during this side question; answer in text.";

export default function btwExtension(pi: ExtensionAPI) {
	// The exact request messages the session last sent (after every extension's
	// mutations), captured like recap and the compaction extension do.
	let capturedMessages: AgentMessage[] | undefined;
	pi.on("context", (event) => {
		capturedMessages = event.messages;
	});

	// The controller for an open panel's in-flight call. Aborted when the session
	// is replaced or torn down, so a late resolve cannot repaint a disposed `tui`
	// or record usage on a stale `pi` (the crash the subagents panel once hit —
	// docs/decisions/tools.md lifecycle review).
	let inFlight: AbortController | undefined;

	// A new session (including after /clear) shares no context with the old one,
	// and any in-flight side question is abandoned.
	pi.on("session_start", () => {
		capturedMessages = undefined;
		inFlight?.abort();
		inFlight = undefined;
	});
	pi.on("session_shutdown", () => {
		inFlight?.abort();
		inFlight = undefined;
	});

	/** Run the side question against the session model; returns the answer text. */
	async function ask(ctx: ExtensionCommandContext, question: string, signal: AbortSignal): Promise<string> {
		const model = ctx.model;
		if (!model) throw new Error("No model is configured for this session.");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error("No API key is available for the current model.");
		const baseUrl = (auth as { baseUrl?: string }).baseUrl;

		const tools = toolStubs(pi.getActiveTools(), STUB_REASON);
		const context = trimToTurnBoundary(capturedMessages ?? []);
		// btw runs on a cheap, possibly text-only reader and answers a text question,
		// so images the conversation carried are stripped before the call
		// (docs/decisions/model-policy.md).
		const messages = [...stripImageBlocks(convertToLlm(context)), { role: "user" as const, content: sideQuestionMessage(question), timestamp: Date.now() }];

		const result = await withReasoningFallback(
			model as Model<Api>,
			(reasoning) => {
				const timeout = AbortSignal.timeout(BTW_TIMEOUT_MS);
				return completeSimple(
					baseUrl ? ({ ...model, baseUrl } as Model<Api>) : (model as Model<Api>),
					{ systemPrompt: "", messages, tools },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						signal: AbortSignal.any([signal, timeout]),
						maxTokens: BTW_MAX_TOKENS,
						...(reasoning ? { reasoning } : {}),
					},
				);
			},
			undefined,
			(usage) => recordUsage(pi, "btw", usage),
		);
		return answerText(result.content);
	}

	pi.registerCommand("btw", {
		description: "Ask a one-off side question, answered from the current context while the main agent keeps working",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Ask a side question: /btw <question>", "info");
				return;
			}

			// Headless (-p / --mode json): no panel — answer and print it. The
			// handler blocks to completion, so the process does not exit early.
			if (!ctx.hasUI) {
				try {
					const answer = await ask(ctx, question, new AbortController().signal);
					ctx.ui.notify(answer || "(no answer)", "info");
				} catch (error) {
					ctx.ui.notify(`Side question failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			// Show the panel at once with a loading line; run the call concurrently
			// and repaint when it lands. Closing the panel — or a session
			// replacement/shutdown — aborts an in-flight call.
			inFlight?.abort();
			const controller = new AbortController();
			inFlight = controller;
			const view: { answer?: string; error?: string } = {};
			const bodyState = (): BtwBody =>
				view.error !== undefined ? { kind: "error", message: view.error } : view.answer !== undefined ? { kind: "answer", text: view.answer } : { kind: "loading" };

			await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
				const state = initialBtwState();
				let cache: { width: number; lines: string[] } | undefined;
				const repaint = () => {
					cache = undefined;
					// A repaint can be requested from an async callback that raced a
					// session teardown; a stale `tui` throws, so never let it propagate.
					try {
						tui.requestRender();
					} catch {}
				};

				// Kick off the model call once, at mount, so `repaint` is bound.
				void (async () => {
					try {
						const answer = await ask(ctx, question, controller.signal);
						if (controller.signal.aborted) return;
						view.answer = answer;
					} catch (error) {
						if (controller.signal.aborted) return;
						view.error = error instanceof Error ? error.message : String(error);
					}
					repaint();
				})();

				return {
					render: (width: number) => {
						if (cache?.width === width) return cache.lines;
						const termRows = (tui as { terminal: { rows: number } }).terminal.rows;
						const height = boundedDockHeight(termRows, BTW_MAX_HEIGHT);
						// Belt-and-suspenders truncate on top of renderBtwPanel's own,
						// matching every sibling dock panel: pi-tui crashes the app on
						// a line wider than the terminal.
						const lines = renderBtwPanel({ state, question, body: bodyState(), width, height }, theme).map((line) => truncateLine(line, width));
						cache = { width, lines };
						return lines;
					},
					handleInput: (data: string) => {
						const key = decodeBtwKey(data);
						if (!key) return;
						const effect = applyBtwKey(state, key);
						switch (effect?.kind) {
							case "close":
								done(null);
								return;
							case "copy":
								// Only offer copy once there is a non-empty answer.
								if (view.answer) {
									void copyToClipboard(view.answer).then(() => {
										state.copied = true;
										repaint();
									});
								}
								return;
							default:
								repaint();
						}
					},
					invalidate: () => {
						cache = undefined;
					},
				};
			});

			controller.abort();
			if (inFlight === controller) inFlight = undefined;
		},
	});
}
