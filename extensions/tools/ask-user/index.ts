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

import { feature } from "../../lib/profile/feature.ts";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canShowCustomUi } from "../../lib/notify/headless-output.ts";
import { ccToolRenderers, safeThemeBold, safeThemeInverse, safeThemePaint } from "../../lib/ui/tui-render.ts";
import { registerFormTool } from "../../lib/profile/tool-variants.ts";
import { requireText } from "../../lib/profile/profile.ts";
import { askThroughDialogs } from "./dialogs.ts";
import type { Answer, Question } from "./questions.ts";
import type { AskUserText } from "./text.ts";
import { applyWidgetKey, createWidgetState, decodeWidgetKey, renderWidget, type WidgetResult } from "./widget.ts";
import { panelUi } from "../../lib/ui/panel-focus.ts";

/** The tool's parameters, documented in the profile's words. */
const askParams = (params: AskUserText["params"]) =>
	Type.Object({
		questions: Type.Array(
			Type.Object({
				question: Type.String({ description: params.question }),
				header: Type.String({ description: params.header }),
				options: Type.Array(
					Type.Object({
						label: Type.String({ description: params.label }),
						description: Type.Optional(Type.String({ description: params.optionDescription })),
						preview: Type.Optional(Type.String({ description: params.preview })),
					}),
					{ minItems: 2, maxItems: 4, description: params.options },
				),
				multiSelect: Type.Optional(Type.Boolean({ description: params.multiSelect })),
			}),
			{ minItems: 1, maxItems: 4, description: params.questions },
		),
	});

function askUserExtension(pi: ExtensionAPI) {
	const text = requireText("askUser");
	// The profile's text, short or long by the model's tier (lib/profile/tool-variants.ts);
	// registered again when the form changes.
	const tool = defineTool({
		name: "ask_user_question",
		label: "Ask User",
		...ccToolRenderers<{ questions?: Array<{ question?: string }> }>("Ask User", {
			title: (a) => a?.questions?.[0]?.question,
		}),
		description: text.description("short"),
		promptSnippet: text.promptSnippet,
		parameters: askParams(text.params),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: text.noInteractiveUi }], details: {}, isError: true };
			}

			const questions = params.questions as Question[];
			// RPC has no custom UI (its custom() resolves undefined); ask through the
			// select/input requests it forwards to the client instead (dialogs.ts).
			const outcome = !canShowCustomUi(ctx) ? await askThroughDialogs(questions, ctx.ui, signal) : await panelUi(pi.events, ctx.ui).custom<WidgetResult>((tui, theme, _keybindings, done) => {
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
				// pi 1.5.0 reports the wait to the terminal (OSC 7501) while the panel shows; older
				// pi ignores it. A fixed label: the report leaves the transcript, and pi sends
				// dialog titles there, never model-written text.
			}, { blocked: { kind: "question", message: questions.length === 1 ? "Question" : `${questions.length} questions` } });

			if (!outcome || outcome.kind === "cancel") {
				const partial = outcome?.kind === "cancel" ? outcome.answers : [];
				return {
					content: [{ type: "text", text: text.cancelled(partial) }],
					details: { answers: partial, cancelled: true },
				};
			}

			if (outcome.kind === "chat") {
				return {
					content: [{ type: "text", text: text.declined(questions) }],
					details: { answers: [] as Answer[], declined: true },
				};
			}

			return {
				content: [{ type: "text", text: text.answered(outcome.answers) }],
				details: { answers: outcome.answers },
			};
		},
	});
	registerFormTool(pi, tool, (form) => text.description(form));
}

export default feature("ask-user", askUserExtension);
