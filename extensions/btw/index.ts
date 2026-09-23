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
 * The call is Claude Code's: the session's last provider request replayed
 * unchanged (system, every tool, every message), the reply that answered it,
 * the session's earlier side exchanges, then the reminder and question, so it
 * reads the cache the session wrote (lib/request-replay.ts; the compaction
 * extension publishes the capture). Without a capture for the session model,
 * or on a provider API the replay does not cover, it falls back to a
 * standalone call: the messages the session last sent (captured from the
 * `context` event), the earlier side exchanges, an empty system prompt,
 * name-only tool stubs so a history carrying tool_use blocks stays valid on
 * strict providers, and withReasoningFallback for models that cannot disable
 * thinking. Both run on the SESSION model: a side question deserves the same
 * quality as the main conversation.
 *
 * Like Claude Code, the session keeps a side history: each answered question
 * is threaded into the next one and listed in the panel, where it can be
 * browsed and cleared. `f` forks the current answer into a background fork
 * subagent through the subagents extension (lib/btw-fork.ts).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requestBtwFork } from "../lib/btw-fork.ts";
import { notifyOrPrint, printAnswer } from "../lib/headless-output.ts";
import { withReasoningFallback } from "../lib/model-policy.ts";
import { followLastExchange, replaySideCall } from "../lib/replay-call.ts";
import { answerText, stripImageBlocks, toolStubs, trimToTurnBoundary, withoutSystemMessages } from "../lib/side-call.ts";
import { boundedDockHeight, truncateLine } from "../lib/tui-render.ts";
import { recordUsage } from "../lib/usage-bus.ts";
import type { ProseRenderer } from "../subagents/panel-render.ts";
import { createMarkdownProse } from "../subagents/prose.ts";
import { type AnswerRenderer, applyBtwKey, type BtwBody, BTW_MAX_HEIGHT, decodeBtwKey, initialBtwState, renderBtwPanel } from "./panel.ts";
import { type BtwExchange, exchangeMessages, historyMessages, sideQuestionMessage } from "./prompt.ts";

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
	// The same request as it went on the wire, and the reply that answered it.
	const exchange = followLastExchange(pi);

	// The session's answered side questions, oldest first: sent before each new
	// question and listed in the panel. `x` in the panel clears them.
	let history: BtwExchange[] = [];

	// The controller for an open panel's in-flight call. Aborted when the session
	// is replaced or torn down, so a late resolve cannot repaint a disposed `tui`
	// or record usage on a stale `pi` (the crash the subagents panel once hit —
	// docs/decisions/tools.md lifecycle review).
	let inFlight: AbortController | undefined;

	// A new session (including after /clear) shares no context with the old one:
	// its side history starts empty and any in-flight side question is abandoned.
	pi.on("session_start", () => {
		capturedMessages = undefined;
		history = [];
		inFlight?.abort();
		inFlight = undefined;
	});
	pi.on("session_shutdown", () => {
		inFlight?.abort();
		inFlight = undefined;
	});

	// The answer renders as Markdown, like the transcript; plain wrapped text
	// until the renderer loads, or if it cannot.
	let prose: ProseRenderer | undefined;
	let proseLoad: Promise<void> | undefined;
	const loadProse = (): Promise<void> =>
		(proseLoad ??= createMarkdownProse().then(
			(renderer) => {
				prose = renderer;
			},
			() => {},
		));
	/** The Markdown renderer caches per ref object; one ref per distinct answer text. */
	const proseRefs = new Map<string, object>();
	const markdownAnswer = (renderer: ProseRenderer): AnswerRenderer => (text, width) => {
		let ref = proseRefs.get(text);
		if (!ref) proseRefs.set(text, (ref = {}));
		return renderer(ref, text, width);
	};

	/** Run the side question against the session model, after the earlier exchanges; returns the answer text. */
	async function ask(ctx: ExtensionCommandContext, question: string, earlier: readonly BtwExchange[], signal: AbortSignal): Promise<string> {
		const model = ctx.model as Model<Api> | undefined;
		if (!model) throw new Error("No model is configured for this session.");
		const before = historyMessages(earlier, model);
		const replayed = await replaySideCall(ctx, model, exchange, sideQuestionMessage(question), {
			signal,
			timeoutMs: BTW_TIMEOUT_MS,
			onUsage: (usage) => recordUsage(pi, "btw", usage),
			history: before,
		});
		if (replayed !== undefined) return replayed;

		// No replay for this model, or it failed: the standalone call.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error("No API key is available for the current model.");
		const baseUrl = (auth as { baseUrl?: string }).baseUrl;
		const tools = toolStubs(pi.getActiveTools(), STUB_REASON);
		const context = trimToTurnBoundary(withoutSystemMessages(capturedMessages ?? []));
		// btw runs on a cheap, possibly text-only reader and answers a text question,
		// so images the conversation carried are stripped before the call
		// (docs/decisions/model-policy.md).
		const messages = [
			...stripImageBlocks(convertToLlm(context)),
			...before,
			{ role: "user" as const, content: sideQuestionMessage(question), timestamp: Date.now() },
		];

		const result = await withReasoningFallback(
			model as Model<Api>,
			(reasoning) => {
				const timeout = AbortSignal.timeout(BTW_TIMEOUT_MS);
				return completeSimple(
					baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model,
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
					const answer = await ask(ctx, question, history, new AbortController().signal);
					if (answer) history.push({ question, answer });
					printAnswer(ctx, answer || "(no answer)");
				} catch (error) {
					notifyOrPrint(ctx, `Side question failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			// Show the panel at once with a loading line; run the call concurrently
			// and repaint when it lands. Closing the panel — or a session
			// replacement/shutdown — aborts an in-flight call.
			inFlight?.abort();
			const controller = new AbortController();
			inFlight = controller;
			// The earlier exchanges this panel lists and browses; the current one
			// joins `history` when it lands, so the next /btw lists it.
			let earlier = [...history];
			const view: { answer?: string; error?: string; forking?: boolean } = {};
			const bodyState = (): BtwBody =>
				view.error !== undefined ? { kind: "error", message: view.error } : view.answer !== undefined ? { kind: "answer", text: view.answer } : { kind: "loading" };
			// Shown after the panel closes: a started fork, or why it could not start.
			let closingNotice: { text: string; level: "info" | "error" } | undefined;

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
				if (!prose) void loadProse().then(() => prose && repaint());

				// Kick off the model call once, at mount, so `repaint` is bound.
				void (async () => {
					try {
						const answer = await ask(ctx, question, earlier, controller.signal);
						if (controller.signal.aborted) return;
						view.answer = answer;
						if (answer) history.push({ question, answer });
					} catch (error) {
						if (controller.signal.aborted) return;
						view.error = error instanceof Error ? error.message : String(error);
					}
					repaint();
				})();

				const fork = (answer: string) => {
					const model = ctx.model as Model<Api> | undefined;
					if (!model) return;
					view.forking = true;
					repaint();
					void requestBtwFork(pi.events, { ctx, question, messages: exchangeMessages({ question, answer }, model) }).then((result) => {
						view.forking = false;
						closingNotice =
							"error" in result ? { text: result.error, level: "error" } : { text: `Forked ${result.name} (${result.taskId.slice(-4)})`, level: "info" };
						done(null);
					});
				};

				return {
					render: (width: number) => {
						if (cache?.width === width) return cache.lines;
						const termRows = (tui as { terminal: { rows: number } }).terminal.rows;
						const height = boundedDockHeight(termRows, BTW_MAX_HEIGHT);
						// Belt-and-suspenders truncate on top of renderBtwPanel's own,
						// matching every sibling dock panel: pi-tui crashes the app on
						// a line wider than the terminal.
						const lines = renderBtwPanel(
							{
								state,
								history: earlier,
								question,
								body: bodyState(),
								width,
								height,
								canFork: true,
								forking: view.forking,
								renderAnswer: prose ? markdownAnswer(prose) : undefined,
							},
							theme,
						).map((line) => truncateLine(line, width));
						cache = { width, lines };
						return lines;
					},
					handleInput: (data: string) => {
						// A fork in flight owns the panel until it answers.
						if (view.forking) return;
						const key = decodeBtwKey(data);
						if (!key) return;
						const effect = applyBtwKey(state, key, earlier.length);
						const shown = state.selected === null ? view.answer : earlier[state.selected]?.answer;
						switch (effect?.kind) {
							case "close":
								done(null);
								return;
							case "copy":
								// Only offer copy once there is a non-empty answer.
								if (shown) {
									void copyToClipboard(shown).then(() => {
										state.copied = true;
										repaint();
									});
								}
								return;
							case "fork":
								// The current answer only, not one browsed from the history.
								if (state.selected === null && view.answer) fork(view.answer);
								return;
							case "clear":
								if (earlier.length === 0) return;
								history = history.filter((entry) => !earlier.includes(entry));
								earlier = [];
								state.selected = null;
								state.offset = 0;
								repaint();
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
			if (closingNotice) ctx.ui.notify(closingNotice.text, closingNotice.level);
		},
	});
}
