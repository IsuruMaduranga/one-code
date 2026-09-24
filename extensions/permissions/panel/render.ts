/**
 * /permissions panel rendering (pure).
 *
 * Returns lines already cut to width; the wiring wraps them in a memoized
 * component and applies a final ANSI-aware truncate (pi-tui crashes on
 * overwide lines, so both layers guard). Wording follows Claude Code's panel
 * (findings §33), naming One Code where Claude Code names itself.
 */

import { cutPlainText, panelTopRule, type RenderBlock as Block, searchBoxLines, truncateLine, visibleWidth, windowBlocks } from "../../lib/tui-render.ts";
import { clampPanelState, detailRule, isRuleTab, type PanelState, type PanelView, ruleListRows, type RuleTab, TABS, type Tab } from "./state.ts";

export interface PanelPaint {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
}

export interface PanelRenderInput {
	state: PanelState;
	view: PanelView;
	width: number;
	height: number;
	/** One dim line under the tabs: the mode and auto mode's state. */
	status?: string;
}

const TAB_TITLES: Record<Tab, string> = {
	recent: "Recently denied",
	allow: "Allow",
	ask: "Ask",
	deny: "Deny",
};

const SUBTITLES: Record<RuleTab, string> = {
	allow: "One Code won't ask before using allowed tools.",
	ask: "One Code will always ask for confirmation before using these tools.",
	deny: "One Code will always reject requests to use denied tools.",
};

const BEHAVIOR_LABEL: Record<RuleTab, string> = { allow: "allowed", ask: "ask", deny: "denied" };

const EMPTY_DENIALS = "No recent denials. Commands denied by the auto mode classifier will appear here.";

function tabBar(state: PanelState, paint: PanelPaint, width: number): string {
	const chips = TABS.map((tab) => (tab === state.tab ? paint.inverse(` ${TAB_TITLES[tab]} `) : ` ${TAB_TITLES[tab]} `));
	return ` ${paint.bold("Permissions")} ${chips.join(" ")}`;
}

/** A cursor-marked list row: `❯ text` in the accent color, or indented. */
function listLine(text: string, isCursor: boolean, paint: PanelPaint, width: number): string {
	const line = cutPlainText(`${isCursor ? "❯" : " "} ${text}`, width - 1);
	return isCursor ? paint.fg("accent", line) : line;
}

function recentBlocks(input: PanelRenderInput, paint: PanelPaint): Block[] {
	const { state, view, width } = input;
	return view.denials.map((denial, index) => {
		const isCursor = index === state.cursor.recent;
		const approved = state.approved.has(denial.id);
		const mark = approved ? paint.fg("success", "✔") : paint.fg("error", "✗");
		const retry = state.retry.has(denial.id) ? " (retry)" : "";
		const rule = denial.rule ? `  [${denial.rule}]` : "";
		// Measured without the paint, then painted: the mark and the dim tail are
		// colored separately from the cursor highlight.
		const room = Math.max(8, width - 5 - visibleWidth(retry) - visibleWidth(rule));
		const body = cutPlainText(denial.display, room);
		const text = isCursor ? paint.fg("accent", body) : body;
		return {
			lines: [`${isCursor ? paint.fg("accent", "❯") : " "} ${mark} ${text}${paint.fg("dim", `${retry}${rule}`)}`],
			selectable: true,
		};
	});
}

function ruleBlocks(input: PanelRenderInput, paint: PanelPaint, tab: RuleTab): Block[] {
	const { state, view, width } = input;
	const rows = ruleListRows(state, view, tab);
	const blocks: Block[] = rows.map((row, index) => {
		const isCursor = index === state.cursor[tab];
		if (row.kind === "add") return { lines: [listLine("Add a new rule…", isCursor, paint, width)], selectable: true };
		// A rule One Code cannot edit names where it lives, dim, when it fits.
		const raw = cutPlainText(row.rule.raw, width - 3);
		const tail = row.rule.editable ? "" : cutPlainText(`  · ${row.rule.sourceLabel.replace(/^From /, "")}`, Math.max(0, width - 3 - visibleWidth(raw)));
		return { lines: [`${listLine(raw, isCursor, paint, width)}${tail ? paint.fg("dim", tail) : ""}`], selectable: true };
	});
	if (view.rules[tab].length === 0) blocks.push({ lines: [paint.fg("dim", `  No ${tab} rules`)], selectable: false });
	else if (rows.length === 0) blocks.push({ lines: [paint.fg("dim", "  No rules match the search")], selectable: false });
	return blocks;
}

function ruleSummary(raw: string, paint: PanelPaint, width: number): string[] {
	const lines = [`   ${paint.bold(cutPlainText(raw, width - 4))}`];
	const description = describeRule(raw);
	if (description) lines.push(paint.fg("dim", cutPlainText(`   ${description}`, width - 1)));
	return lines;
}

/** The body and footer of an open dialog. */
function dialogLines(input: PanelRenderInput, paint: PanelPaint): { lines: string[]; footer: string } | undefined {
	const { state, view, width } = input;
	const dialog = state.dialog;
	if (!dialog) return undefined;
	const text = (line: string) => cutPlainText(` ${line}`, width - 1);

	if (dialog.kind === "addRule") {
		return {
			lines: [
				paint.fg("accent", paint.bold(text(`Add ${dialog.behavior} permission rule`))),
				"",
				text("Permission rules are a tool name, optionally followed by a specifier in parentheses."),
				text("e.g., WebFetch or Bash(ls:*)"),
				"",
				...searchBoxLines(dialog.draft, "Enter permission rule…", paint.fg, width).map((line) => line.replace("⌕ ", "")),
			],
			footer: "Enter to submit · Esc to cancel",
		};
	}

	if (dialog.kind === "saveRule") {
		const lines = [
			paint.fg("accent", paint.bold(text(`Add ${dialog.behavior} permission rule`))),
			"",
			...ruleSummary(dialog.rule, paint, width),
			"",
			text("Where should this rule be saved?"),
		];
		view.destinations.forEach((destination, index) => {
			const isCursor = index === dialog.cursor;
			lines.push(listLine(`${index + 1}. ${destination.label}`, isCursor, paint, width));
			lines.push(paint.fg("dim", cutPlainText(`     ${destination.description}`, width - 1)));
		});
		return { lines, footer: "↑↓ to choose · Enter to save · Esc to go back" };
	}

	const rule = detailRule(dialog, view);
	if (!rule) return { lines: [paint.fg("dim", text("(this rule is no longer in the list)"))], footer: "Esc to go back" };
	const details = [...ruleSummary(rule.raw, paint, width), paint.fg("dim", cutPlainText(`   ${rule.sourceLabel}`, width - 1))];
	if (!rule.editable) {
		return {
			lines: [paint.bold(text("Rule details")), "", ...details, "", ...(rule.readOnlyNote ? [text(rule.readOnlyNote)] : [])],
			footer: "Enter or Esc to go back",
		};
	}
	return {
		lines: [
			paint.fg("error", paint.bold(text(`Delete ${BEHAVIOR_LABEL[dialog.behavior]} tool?`))),
			"",
			...details,
			"",
			text("Are you sure you want to delete this permission rule?"),
			listLine("Yes", dialog.cursor === 0, paint, width),
			listLine("No", dialog.cursor === 1, paint, width),
		],
		footer: "↑↓ to choose · Enter to confirm · Esc to go back",
	};
}

/**
 * Claude Code's rule descriptions (`PermissionRuleDescription`): what a Bash
 * rule matches, or that a bare tool name covers every use of the tool.
 */
export function describeRule(raw: string): string | undefined {
	const match = /^([^()]+?)(?:\((.*)\))?$/s.exec(raw.trim());
	if (!match) return undefined;
	const [, tool, content] = match;
	if (/^bash$/i.test(tool)) {
		if (!content) return "Any Bash command";
		if (content.endsWith(":*")) return `Any Bash command starting with ${content.slice(0, -2)}`;
		return `The Bash command ${content}`;
	}
	return content ? undefined : `Any use of the ${tool} tool`;
}

function footerFor(state: PanelState, view: PanelView): string[] {
	if (state.tab === "recent") {
		if (view.denials.length === 0) return ["←/→ to switch tabs · Esc to close"];
		const pending = state.approved.size > 0 ? ["Approvals apply when you close the panel."] : [];
		return ["Enter to approve · r to retry · ↑↓ to navigate · ←/→ to switch tabs · Esc to close", ...pending];
	}
	if (state.searching) return ["Type to filter · Enter to select · Backspace to edit · Esc to clear"];
	return ["↑↓ to navigate · Enter to select · Type to search · ←/→ to switch tabs · Esc to close"];
}

export function renderPanel(input: PanelRenderInput, paint: PanelPaint): string[] {
	const { state, view, width, height } = input;
	clampPanelState(state, view);

	const out: string[] = [panelTopRule(paint.fg, width), tabBar(state, paint, width)];
	if (input.status) out.push(paint.fg("dim", cutPlainText(` ${input.status}`, width - 1)));
	out.push("");

	let footer: string[];
	const dialog = dialogLines(input, paint);
	if (dialog) {
		out.push(...dialog.lines);
		footer = [dialog.footer];
	} else {
		let blocks: Block[];
		if (isRuleTab(state.tab)) {
			out.push(cutPlainText(` ${SUBTITLES[state.tab]}`, width - 1));
			const placeholder = state.searching ? "Search…" : "Type to search…";
			out.push(...searchBoxLines(state.search[state.tab], placeholder, paint.fg, width));
			blocks = ruleBlocks(input, paint, state.tab);
		} else if (view.denials.length === 0) {
			blocks = [{ lines: [paint.fg("dim", cutPlainText(` ${EMPTY_DENIALS}`, width - 1))], selectable: false }];
		} else {
			out.push(cutPlainText(" Commands recently denied by the auto mode classifier.", width - 1), "");
			blocks = recentBlocks(input, paint);
		}
		footer = footerFor(state, view);
		const budget = Math.max(3, height - out.length - 2 - footer.length - (state.notice ? 1 : 0));
		const windowed = windowBlocks(blocks, state.cursor[state.tab], budget);
		out.push(...windowed.lines);
		if (windowed.more > 0) out.push(paint.fg("dim", `  ↓ more below (${windowed.more})`));
	}

	if (state.notice) out.push(paint.fg("warning", cutPlainText(`  ${state.notice}`, width - 1)));
	out.push("", ...footer.map((line) => paint.fg("dim", cutPlainText(` ${line}`, width - 1))));
	// Painted rows (the tab bar, a denial's mark and tail) are measured after
	// painting, so every line gets a final column-aware cut.
	return out.map((line) => truncateLine(line, width));
}
