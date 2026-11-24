/**
 * The transcript's view of an ask_user_question result (pure): one
 * `· question → answer` line per answered question, Claude Code's shape for
 * its answers (captured, findings §103), read from the result's
 * `details`, never from the model-facing sentence around them.
 */

import { elbowIndent, wrapProse } from "./tui-render.ts";
import { sanitizeDisplayText } from "./terminal-text.ts";

/** The slice of the ask-user extension's answer the view reads. */
interface AnswerLike {
	question?: unknown;
	selected?: unknown;
}

/** The questions as the call asked them: the declined row lists each with its options. */
interface AskedLike {
	question?: unknown;
	options?: Array<{ label?: unknown }>;
}

/**
 * The block for a settled ask_user_question, all dim and with no call line,
 * as Claude Code draws it (findings §103), worded without naming the
 * assistant: `● Answered the questions:` then `⎿  · question → answer` per
 * answered question, or `● Declined to answer the questions:` then
 * `⎿  · question (A / B)` per question asked. Undefined shows the result as
 * written.
 */
export function askUserRows(details: unknown, args: { questions?: AskedLike[] } | undefined, width: number): string[] | undefined {
	const d = details as { answers?: unknown; cancelled?: unknown; declined?: unknown } | undefined;
	if (!d) return undefined;
	let title: string;
	let items: string[];
	if (d.declined === true || d.cancelled === true) {
		title = "Declined to answer the questions:";
		items = (args?.questions ?? []).flatMap((asked) => {
			if (typeof asked?.question !== "string") return [];
			const labels = (asked.options ?? []).map((option) => option?.label).filter((label): label is string => typeof label === "string");
			return [`· ${asked.question}${labels.length ? ` (${labels.join(" / ")})` : ""}`];
		});
	} else {
		if (!Array.isArray(d.answers)) return undefined;
		title = "Answered the questions:";
		items = (d.answers as AnswerLike[]).flatMap((answer) => {
			const selected = Array.isArray(answer?.selected) ? answer.selected.filter((s): s is string => typeof s === "string") : [];
			if (typeof answer?.question !== "string" || selected.length === 0) return [];
			return [`· ${answer.question} → ${selected.join(", ")}`];
		});
	}
	if (items.length === 0) return undefined;
	// Each item wraps under the elbow with its hang, as Claude Code wraps a long question.
	return [`● ${title}`, ...elbowIndent(items.flatMap((item) => wrapProse(sanitizeDisplayText(item), Math.max(1, width - 5))))];
}
