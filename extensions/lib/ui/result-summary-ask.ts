/**
 * The transcript's view of an ask_user_question result (pure): one
 * `· question → answer` line per answered question, Claude Code's shape for
 * its answers (reconstructed source, a lead), read from the result's
 * `details`, never from the model-facing sentence around them. ctrl+o shows
 * the whole result.
 */

/** The slice of the ask-user extension's answer the view reads. */
interface AnswerLike {
	question?: unknown;
	selected?: unknown;
}

/** Claude Code's line for questions the user dismissed. */
export const DECLINED_LINE = "User declined to answer questions";

/** The collapsed result's lines, or undefined to show the result as written. */
export function askUserResultLines(details: unknown): string | undefined {
	const d = details as { answers?: unknown; cancelled?: unknown; declined?: unknown } | undefined;
	if (!d) return undefined;
	if (d.declined === true || d.cancelled === true) return DECLINED_LINE;
	if (!Array.isArray(d.answers)) return undefined;
	const lines = (d.answers as AnswerLike[]).flatMap((answer) => {
		const selected = Array.isArray(answer?.selected) ? answer.selected.filter((s): s is string => typeof s === "string") : [];
		if (typeof answer?.question !== "string" || selected.length === 0) return [];
		return [`· ${answer.question} → ${selected.join(", ")}`];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}
