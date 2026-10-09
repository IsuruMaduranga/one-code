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

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canShowCustomUi } from "../lib/headless-output.ts";
import { ccToolRenderers, safeThemeBold, safeThemeInverse, safeThemePaint } from "../lib/tui-render.ts";
import { registerFormTool } from "../lib/tool-variants.ts";
import { ASK_PARAMS, askDescription } from "./description.ts";
import { askThroughDialogs } from "./dialogs.ts";
import { type Answer, answerPairs, formatAnswers, formatDecline, type Question } from "./questions.ts";
import { applyWidgetKey, createWidgetState, decodeWidgetKey, renderWidget, type WidgetResult } from "./widget.ts";

const NON_INTERACTIVE =
	"This session has no interactive UI, so the user cannot be shown a dialog. Ask your question in your reply instead and stop, or proceed under a stated assumption.";

const AskParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: ASK_PARAMS.question }),
			header: Type.String({ description: ASK_PARAMS.header }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: ASK_PARAMS.label }),
					description: Type.Optional(Type.String({ description: ASK_PARAMS.optionDescription })),
					preview: Type.Optional(Type.String({ description: ASK_PARAMS.preview })),
				}),
				{ minItems: 2, maxItems: 4, description: ASK_PARAMS.options },
			),
			multiSelect: Type.Optional(Type.Boolean({ description: ASK_PARAMS.multiSelect })),
		}),
		{ minItems: 1, maxItems: 4, description: ASK_PARAMS.questions },
	),
});

export default function askUserExtension(pi: ExtensionAPI) {
	// Claude Code's AskUserQuestion text, short or long by the model's tier
	// (description.ts, lib/tool-variants.ts); registered again when the form changes.
	const tool = defineTool({
		name: "ask_user_question",
		label: "Ask User",
		...ccToolRenderers<{ questions?: Array<{ question?: string }> }>("Ask User", {
			title: (a) => a?.questions?.[0]?.question,
		}),
		description: askDescription("short"),
		promptSnippet: "Ask the user to decide between options when genuinely blocked",
		parameters: AskParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: NON_INTERACTIVE }], details: {}, isError: true };
			}

			const questions = params.questions as Question[];
			// RPC has no custom UI (its custom() resolves undefined); ask through the
			// select/input requests it forwards to the client instead (dialogs.ts).
			const outcome = !canShowCustomUi(ctx) ? await askThroughDialogs(questions, ctx.ui, signal) : await ctx.ui.custom<WidgetResult>((tui, theme, _keybindings, done) => {
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
						? `The user cancelled without submitting. They had made these selections before cancelling (NOT submitted — do not treat them as final answers): ${answerPairs(partial)}.`
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
	registerFormTool(pi, tool, askDescription);
}
