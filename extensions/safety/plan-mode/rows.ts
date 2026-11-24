/**
 * The transcript rows for enter_plan_mode and exit_plan_mode (pure): Claude
 * Code's, with no call line (findings §103), worded without naming the
 * assistant, since a product vendors this base. Built from the result's
 * details, which never reach the model; undefined leaves the result to the
 * tool's ordinary rendering (an error these rows do not cover, a session
 * recorded before the details existed).
 */

import { homedir } from "node:os";
import { tildify } from "../../lib/profile/paths.ts";
import { elbowIndent, type RowView, type ThemeLike, wrapProse } from "../../lib/ui/tui-render.ts";
import { sanitizeDisplayText } from "../../lib/ui/terminal-text.ts";
import { visibleWidth } from "../../lib/ui/text-width.ts";
import { userDenialKind } from "../../lib/consent/user-denial.ts";

/** What the plan-mode tools put in their results' details. */
export interface PlanDetails {
	planFilePath?: string;
	plan?: string;
	approved?: boolean;
}

/** The row's view, plus the result's text: the user's rejection is told by it, as `rejectionLine` tells it. */
type View = RowView & { text?: string };

/** The colour Claude Code gives plan mode's rows; One Code's themes have no plan colour, so the status accent. */
const PLAN = "accent";
/** The columns `elbowIndent` takes before a result body. */
const ELBOW = 5;

const head = (theme: ThemeLike, title: string) => `${theme.fg(PLAN, "●")} ${theme.fg(PLAN, title)}`;

/** `● Entered plan mode` and Claude Code's dim second line. */
export function enteredRows(details: PlanDetails | undefined, view: View): string[] | undefined {
	if (view.isError || !details?.planFilePath) return undefined;
	return [head(view.theme, "Entered plan mode"), `  ${view.theme.fg("dim", "Exploring and planning an approach.")}`];
}

/** An approved plan: the title, where the plan was saved, and the plan. A rejected one: the plan in a box. */
export function exitedRows(details: PlanDetails | undefined, view: View): string[] | undefined {
	if (typeof details?.plan !== "string") return undefined;
	const { theme, width } = view;
	const plan = sanitizeDisplayText(details.plan.replace(/\s+$/, ""));
	if (!view.isError && details.approved === true) {
		const saved = details.planFilePath ? [theme.fg("dim", `Plan saved to: ${sanitizeDisplayText(tildify(details.planFilePath, homedir()))}`)] : [];
		return [head(theme, "Approved the plan"), ...elbowIndent([...saved, ...wrapProse(plan, Math.max(1, width - ELBOW))])];
	}
	if (view.isError && userDenialKind(view.text ?? "")) {
		return elbowIndent([theme.fg("dim", "Rejected the plan:"), ...box(theme, plan, width - ELBOW)]);
	}
	return undefined;
}

/** The plan in a rounded box in the plan colour, as wide as its longest line and no wider than `columns`. */
function box(theme: ThemeLike, text: string, columns: number): string[] {
	const room = Math.max(1, columns - 4);
	const lines = text ? wrapProse(text, room) : [];
	const inner = Math.min(room, Math.max(1, ...lines.map((line) => visibleWidth(line))));
	const edge = (left: string, right: string) => theme.fg(PLAN, `${left}${"─".repeat(inner + 2)}${right}`);
	const side = theme.fg(PLAN, "│");
	return [edge("╭", "╮"), ...lines.map((line) => `${side} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${side}`), edge("╰", "╯")];
}
