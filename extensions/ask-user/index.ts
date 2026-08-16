/**
 * ask-user extension — Claude Code's AskUserQuestion.
 *
 * Asks the user up to four multiple-choice questions in one tabbed dialog
 * (widget.ts): a tab per question plus Submit, option previews rendered
 * beside the list, per-question notes, multi-select checkboxes, an inline
 * free-text row, and "Chat about this" to decline and discuss in chat
 * instead. The collected answers come back as one tool result.
 *
 * Replaces the community `pi-ask-user`, which asked one question per call and
 * pulled in a second, conflicting TypeBox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ccToolRenderers, safeThemeBold, safeThemeInverse, safeThemePaint } from "../lib/tui-render.ts";
import { type Answer, formatAnswers, formatDecline, type Question } from "./questions.ts";
import { applyWidgetKey, createWidgetState, decodeWidgetKey, renderWidget, type WidgetResult } from "./widget.ts";

const NON_INTERACTIVE =
	"This session has no interactive UI, so the user cannot be shown a dialog. Ask your question in your reply instead and stop, or proceed under a stated assumption.";

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		...ccToolRenderers<{ questions?: Array<{ question?: string }> }>("Ask User", {
			title: (a) => a?.questions?.[0]?.question,
		}),
		description:
			"Ask the user to choose between options when you are blocked on a decision that is genuinely theirs — one you cannot resolve from the request, the code, or a sensible default. Ask up to four questions in one call; the user answers them in one tabbed dialog and can decline into a chat discussion instead. Options on single-select questions may carry a `preview` — an ASCII mockup, diagram, or code snippet rendered beside the list while the user compares choices; use previews when seeing the alternatives helps (UI layouts, code style variants), never for plain preference questions. Non-preview questions get a free-text 'Other' row automatically, so never add an 'Other' option yourself. Do not use this tool for choices with an obvious default or for facts you can verify yourself.",
		promptSnippet: "Ask the user to decide between options when genuinely blocked",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The question, ending in a question mark" }),
					header: Type.String({ description: "Very short label for the question (a few words)" }),
					multiSelect: Type.Optional(
						Type.Boolean({ description: "Allow choosing several options (default false)" }),
					),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "Short choice text" }),
							description: Type.Optional(Type.String({ description: "What choosing this means" })),
							preview: Type.Optional(
								Type.String({
									description:
										"Preview shown beside the options while this option is focused: an ASCII mockup, diagram, or code snippet that helps the user compare choices. Single-select questions only.",
								}),
							),
						}),
						{ minItems: 2, maxItems: 4 },
					),
				}),
				{ minItems: 1, maxItems: 4, description: "Questions to ask (1-4)" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: NON_INTERACTIVE }], details: {}, isError: true };
			}

			const questions = params.questions as Question[];
			const outcome = await ctx.ui.custom<WidgetResult>((tui, theme, _keybindings, done) => {
				const style = {
					paint: safeThemePaint(theme),
					bold: safeThemeBold(theme),
					inverse: safeThemeInverse(theme),
				};
				const state = createWidgetState(questions);
				// The output only changes on input or resize, but pi-tui calls
				// render every frame — cache by width, drop the cache per keypress.
				let cache: { width: number; lines: string[] } | undefined;
				return {
					render: (width: number) => {
						if (cache?.width !== width) cache = { width, lines: renderWidget(state, style, width) };
						return cache.lines;
					},
					handleInput: (data: string) => {
						const key = decodeWidgetKey(data);
						if (!key) return;
						const resolved = applyWidgetKey(state, key);
						if (resolved) return done(resolved);
						cache = undefined;
						tui.requestRender();
					},
					invalidate: () => {
						cache = undefined;
					},
				};
			});

			if (!outcome || outcome.kind === "cancel") {
				const partial = outcome?.kind === "cancel" ? outcome.answers : [];
				const text =
					partial.length > 0
						? `The user cancelled without submitting. They had made these selections before cancelling (NOT submitted — do not treat them as final answers):\n\n${formatAnswers(partial)}`
						: "The user cancelled without answering.";
				return {
					content: [{ type: "text", text }],
					details: { answers: partial, cancelled: true },
				};
			}

			if (outcome.kind === "chat") {
				return {
					content: [{ type: "text", text: formatDecline(questions) }],
					details: { answers: [] as Answer[], declined: true },
				};
			}

			return {
				content: [{ type: "text", text: formatAnswers(outcome.answers) }],
				details: { answers: outcome.answers },
			};
		},
	});
}
