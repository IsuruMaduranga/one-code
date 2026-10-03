/**
 * ask_user_question's model-facing texts: Claude Code's AskUserQuestion
 * description and parameter texts (pure).
 *
 * The short form goes to frontier and workhorse models; the long form, the
 * same text without the "Reserve this for decisions…" paragraph, to cheap
 * and tiny ones (lib/tool-variants.ts). The plan-mode note names One Code's
 * tools and drops "the user cannot see the plan until you call ExitPlanMode":
 * One Code's plan is a file the user can open at any time.
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

export const ASK_SHORT_DESCRIPTION = `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: To switch into plan mode, use enter_plan_mode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — plan approval goes through exit_plan_mode.

Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`;

export const ASK_LONG_DESCRIPTION = `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: To switch into plan mode, use enter_plan_mode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — plan approval goes through exit_plan_mode.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`;

export function askDescription(form: DescriptionForm): string {
	return form === "long" ? ASK_LONG_DESCRIPTION : ASK_SHORT_DESCRIPTION;
}

export const ASK_PARAMS = {
	questions: `Questions to ask the user (1-4 questions)`,
	question: `The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"`,
	header: `Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".`,
	options: `The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.`,
	multiSelect: `Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.`,
	label: `The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
	optionDescription: `Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.`,
	preview: `Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.`,
} as const;
