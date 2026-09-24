/**
 * /permissions panel rendering (pure).
 *
 * Returns lines already cut to terminal columns (pi-tui crashes on an
 * overwide line). Wording follows Claude Code's panel (findings §33), naming
 * One Code where Claude Code names itself.
 */

import { cutPlainText, panelTopRule, type RenderBlock as Block, searchBoxLines, truncateLine, visibleWidth, windowBlocks, wrapPlainText } from "../../lib/tui-render.ts";
import {
	AUTO_SECTION_LABELS,
	AUTO_SECTIONS,
	type AutoEntryRow,
	type AutoSection,
	autoEntry,
	autoListRows,
	clampPanelState,
	detailRule,
	type Dialog,
	isRuleTab,
	type PanelState,
	type PanelView,
	ruleListRows,
	type RuleTab,
	TABS,
	type Tab,
	workspaceDir,
	workspaceListRows,
} from "./state.ts";

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
	automode: "Auto mode",
	workspace: "Workspace",
};

const WORKSPACE_SUBTITLE = "One Code can read files in the workspace, and make edits when auto-accept edits is on.";
/** Claude Code's three answers when a directory is added. */
const REMEMBER_OPTIONS = ["Yes, for this session", "Yes, and remember this directory", "No"];

const SUBTITLES: Record<RuleTab | "automode", string> = {
	allow: "One Code won't ask before using allowed tools.",
	ask: "One Code will always ask for confirmation before using these tools.",
	deny: "One Code will always reject requests to use denied tools.",
	automode: "Extra rules for the auto mode classifier. Rules are plain sentences; new rules are saved to your user settings.",
};

const BEHAVIOR_LABEL: Record<RuleTab, string> = { allow: "allowed", ask: "ask", deny: "denied" };

const SECTION_LABEL = AUTO_SECTION_LABELS;
/** Claude Code's section colors. */
const SECTION_COLOR: Record<AutoSection, string> = { allow: "success", soft_deny: "warning", hard_deny: "error" };
/** Claude Code's section descriptions, from its "What kind of rule is this?" picker. */
const SECTION_DESCRIPTION: Record<AutoSection, string> = {
	allow: "Actions the classifier lets run without blocking",
	soft_deny: "Actions the classifier blocks, unless a soft allow rule or your explicit direction applies",
	hard_deny: "Actions the classifier always blocks; soft allow rules cannot override",
};
/** Wide enough for the longest section label, "Environment". */
const LABEL_COLUMNS = 13;
/** Environment lines the Auto mode tab shows before `… (+N more lines)`. */
const ENVIRONMENT_PREVIEW = 4;

const EMPTY_DENIALS = "No recent denials. Commands denied by the auto mode classifier will appear here.";

function tabBar(state: PanelState, paint: PanelPaint): string {
	const chips = TABS.map((tab) => (tab === state.tab ? paint.inverse(` ${TAB_TITLES[tab]} `) : ` ${TAB_TITLES[tab]} `));
	return ` ${paint.bold("Permissions")} ${chips.join(" ")}`;
}

/** A cursor-marked list row: `❯ text` in the accent color, or indented. */
function listLine(text: string, isCursor: boolean, paint: PanelPaint, width: number): string {
	const line = cutPlainText(`${isCursor ? "❯" : " "} ${text}`, width - 1);
	return isCursor ? paint.fg("accent", line) : line;
}

/** A dim ` · <source>` tail naming where an uneditable entry lives, cut to what is left of the row. */
function sourceTail(entry: { editable: boolean; sourceLabel: string }, used: number, width: number): string {
	return entry.editable ? "" : cutPlainText(`  · ${entry.sourceLabel.replace(/^From /, "")}`, Math.max(0, width - 3 - used));
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
		const raw = cutPlainText(row.rule.raw, width - 3);
		const tail = sourceTail(row.rule, visibleWidth(raw), width);
		return { lines: [`${listLine(raw, isCursor, paint, width)}${tail ? paint.fg("dim", tail) : ""}`], selectable: true };
	});
	if (view.rules[tab].length === 0) blocks.push({ lines: [paint.fg("dim", `  No ${tab} rules`)], selectable: false });
	else if (rows.length === 0) blocks.push({ lines: [paint.fg("dim", "  No rules match the search")], selectable: false });
	return blocks;
}

/** `  Soft deny    ` in the section's color: the fixed-width label column of an Auto mode row. */
function sectionLabel(label: string, color: string | undefined, paint: PanelPaint): string {
	const padded = label.padEnd(LABEL_COLUMNS);
	return color ? paint.fg(color, padded) : padded;
}

function autoBlocks(input: PanelRenderInput, paint: PanelPaint): Block[] {
	const { state, view, width } = input;
	const rows = autoListRows(state, view);
	const auto = view.autoMode;
	const room = Math.max(8, width - 4 - LABEL_COLUMNS);
	const marker = (isCursor: boolean) => (isCursor ? paint.fg("accent", "❯") : " ");
	const body = (text: string, isCursor: boolean) => (isCursor ? paint.fg("accent", text) : text);
	const blocks: Block[] = rows.map((row, index) => {
		const isCursor = index === state.cursor.automode;
		switch (row.kind) {
			case "add":
				return { lines: [listLine("Add a new rule…", isCursor, paint, width)], selectable: true };
			case "builtins": {
				const text = cutPlainText(`Built-in rules · ${auto.builtins[row.section]} · always in effect`, room);
				return { lines: [`${marker(isCursor)} ${sectionLabel(SECTION_LABEL[row.section], SECTION_COLOR[row.section], paint)}${body(text, isCursor)}`], selectable: true };
			}
			case "entry": {
				const text = cutPlainText(row.entry.text, room);
				const tail = sourceTail(row.entry, LABEL_COLUMNS + visibleWidth(text), width);
				const label = sectionLabel(SECTION_LABEL[row.entry.section], SECTION_COLOR[row.entry.section], paint);
				return { lines: [`${marker(isCursor)} ${label}${body(text, isCursor)}${tail ? paint.fg("dim", tail) : ""}`], selectable: true };
			}
			case "environment": {
				const env = auto.environment;
				const head = cutPlainText(`${env.summary} · enter to edit`, room);
				const indent = " ".repeat(2 + LABEL_COLUMNS);
				const preview = env.lines.slice(0, ENVIRONMENT_PREVIEW).map((line) => paint.fg("dim", `${indent}${cutPlainText(line, room)}`));
				const more = env.lines.length > ENVIRONMENT_PREVIEW ? [paint.fg("dim", `${indent}… (+${env.lines.length - ENVIRONMENT_PREVIEW} more lines)`)] : [];
				return { lines: [`${marker(isCursor)} ${sectionLabel("Environment", undefined, paint)}${body(head, isCursor)}`, ...preview, ...more], selectable: true };
			}
		}
	});
	if (rows.length === 0) blocks.push({ lines: [paint.fg("dim", "  No rules match the search")], selectable: false });
	return blocks;
}

function workspaceBlocks(input: PanelRenderInput, paint: PanelPaint): Block[] {
	const { state, view, width } = input;
	return workspaceListRows(view).map((row, index) => {
		const isCursor = index === state.cursor.workspace;
		if (row.kind === "add") return { lines: [listLine("Add directory…", isCursor, paint, width)], selectable: true };
		const path = cutPlainText(row.dir.path, width - 3);
		const tail = sourceTail(row.dir, visibleWidth(path), width);
		return { lines: [`${listLine(path, isCursor, paint, width)}${tail ? paint.fg("dim", tail) : ""}`], selectable: true };
	});
}

function ruleSummary(raw: string, paint: PanelPaint, width: number): string[] {
	const lines = [`   ${paint.bold(cutPlainText(raw, width - 4))}`];
	const description = describeRule(raw);
	if (description) lines.push(paint.fg("dim", cutPlainText(`   ${description}`, width - 1)));
	return lines;
}

/** Yes/No or Edit/Delete: two cursor-marked options. */
function choiceLines(options: [string, string], cursor: number, paint: PanelPaint, width: number): string[] {
	return options.map((option, index) => listLine(option, cursor === index, paint, width));
}

/** An auto-mode entry's text wrapped under a heading, with where it lives. */
function autoEntrySummary(entry: AutoEntryRow, paint: PanelPaint, width: number): string[] {
	return [
		paint.fg(SECTION_COLOR[entry.section], cutPlainText(`   ${SECTION_LABEL[entry.section]}`, width - 1)),
		...wrapPlainText(entry.text, Math.max(10, width - 6)).map((line) => `   ${paint.bold(line)}`),
		paint.fg("dim", cutPlainText(`   ${entry.sourceLabel}`, width - 1)),
	];
}

/** The body and footer of an open dialog. */
function dialogLines(dialog: Dialog, input: PanelRenderInput, paint: PanelPaint): { lines: string[]; footer: string } {
	const { view, width } = input;
	const text = (line: string) => cutPlainText(` ${line}`, width - 1);
	const wrapped = (line: string) => wrapPlainText(line, Math.max(10, width - 2)).map((part) => ` ${part}`);
	const gone = { lines: [paint.fg("dim", text("(this entry is no longer in the list)"))], footer: "Esc to go back" };
	const draftBox = (draft: string, placeholder: string) => searchBoxLines(draft, placeholder, paint.fg, width).map((line) => line.replace("⌕ ", ""));

	switch (dialog.kind) {
		case "addRule":
			return {
				lines: [
					paint.fg("accent", paint.bold(text(`Add ${dialog.behavior} permission rule`))),
					"",
					text("Permission rules are a tool name, optionally followed by a specifier in parentheses."),
					text("e.g., WebFetch or Bash(ls:*)"),
					"",
					...draftBox(dialog.draft, "Enter permission rule…"),
				],
				footer: "Enter to submit · Esc to cancel",
			};
		case "saveRule": {
			const lines = [
				paint.fg("accent", paint.bold(text(`Add ${dialog.behavior} permission rule`))),
				"",
				...ruleSummary(dialog.rule, paint, width),
				"",
				text("Where should this rule be saved?"),
			];
			view.destinations.forEach((destination, index) => {
				lines.push(listLine(`${index + 1}. ${destination.label}`, index === dialog.cursor, paint, width));
				lines.push(paint.fg("dim", cutPlainText(`     ${destination.description}`, width - 1)));
			});
			return { lines, footer: "↑↓ to choose · Enter to save · Esc to go back" };
		}
		case "ruleDetail": {
			const rule = detailRule(dialog, view);
			if (!rule) return gone;
			const details = [...ruleSummary(rule.raw, paint, width), paint.fg("dim", cutPlainText(`   ${rule.sourceLabel}`, width - 1))];
			if (!rule.editable) {
				return { lines: [paint.bold(text("Rule details")), "", ...details, "", ...(rule.readOnlyNote ? wrapped(rule.readOnlyNote) : [])], footer: "Enter or Esc to go back" };
			}
			return {
				lines: [
					paint.fg("error", paint.bold(text(`Delete ${BEHAVIOR_LABEL[dialog.behavior]} tool?`))),
					"",
					...details,
					"",
					text("Are you sure you want to delete this permission rule?"),
					...choiceLines(["Yes", "No"], dialog.cursor, paint, width),
				],
				footer: "↑↓ to choose · Enter to confirm · Esc to go back",
			};
		}
		case "pickSection": {
			const lines = [paint.fg("accent", paint.bold(text("Add auto mode rule"))), "", text("What kind of rule is this?")];
			AUTO_SECTIONS.forEach((section, index) => {
				lines.push(listLine(`${index + 1}. ${SECTION_LABEL[section]}`, index === dialog.cursor, paint, width));
				lines.push(paint.fg("dim", cutPlainText(`     ${SECTION_DESCRIPTION[section]}`, width - 1)));
			});
			return { lines, footer: "↑↓ to choose · Enter to select · Esc to cancel" };
		}
		case "autoRuleInput":
			return {
				lines: [
					paint.fg("accent", paint.bold(text(`${dialog.editKey ? "Edit" : "Add"} ${SECTION_LABEL[dialog.section].toLowerCase()} rule`))),
					"",
					...wrapped("Write the rule as a plain sentence. A short label up front helps, e.g., Database Writes: UPDATE statements against the local dev database."),
					"",
					...draftBox(dialog.draft, "Enter rule…"),
					paint.fg("dim", text("Saved to your One Code user settings, for every project.")),
				],
				footer: "Enter to save · Esc to cancel",
			};
		case "autoRuleDetail": {
			const entry = autoEntry(dialog.key, view);
			if (!entry) return gone;
			if (!entry.editable) {
				return { lines: [paint.bold(text("Auto mode rule")), "", ...autoEntrySummary(entry, paint, width), "", ...(entry.readOnlyNote ? wrapped(entry.readOnlyNote) : [])], footer: "Enter or Esc to go back" };
			}
			return {
				lines: [paint.bold(text("Auto mode rule")), "", ...autoEntrySummary(entry, paint, width), "", ...choiceLines(["Edit", "Delete"], dialog.cursor, paint, width)],
				footer: "↑↓ to choose · Enter to confirm · e to edit · d to delete · Esc to go back",
			};
		}
		case "autoRuleDelete": {
			const entry = autoEntry(dialog.key, view);
			if (!entry) return gone;
			const last = view.autoMode.entries.filter((other) => other.section === entry.section && other.editable).length === 1;
			return {
				lines: [
					paint.fg("error", paint.bold(text("Delete auto mode rule?"))),
					"",
					...autoEntrySummary(entry, paint, width),
					"",
					...wrapped(
						`Are you sure you want to delete this rule? The classifier stops applying it on your next request.${last ? " This is your last rule in this section; the built-in rules still apply." : ""}`,
					),
					...choiceLines(["Yes", "No"], dialog.cursor, paint, width),
				],
				footer: "↑↓ to choose · Enter to confirm · Esc to go back",
			};
		}
		case "builtinsInfo":
			return {
				lines: [
					paint.fg(SECTION_COLOR[dialog.section], paint.bold(text(`${SECTION_LABEL[dialog.section]} · built-in rules`))),
					"",
					...wrapped(
						`The ${view.autoMode.builtins[dialog.section]} built-in ${SECTION_LABEL[dialog.section].toLowerCase()} rules are always in effect in One Code. Your own rules are added after them and never replace them, so a rule can tighten or carve out, but not switch the built-ins off.`,
					),
					"",
					...wrapped("Run /auto-mode defaults to print them."),
				],
				footer: "Enter or Esc to go back",
			};
		case "envConfirm":
			return {
				lines: [
					paint.fg("warning", paint.bold(text("Replace the built-in environment?"))),
					"",
					...wrapped(
						"Writing your own environment replaces the built-in default document: the classifier context that defines trusted hosts, sensitive targets, and repository scope. The editor starts from the full default text so you can edit rather than rewrite; deleting all your environment entries later restores the default.",
					),
					"",
					...choiceLines(["Yes, edit the environment", "No"], dialog.cursor, paint, width),
				],
				footer: "↑↓ to choose · Enter to confirm · Esc to go back",
			};
		case "addDir":
			return {
				lines: [paint.fg("accent", paint.bold(text("Add directory to workspace"))), "", text("Enter the path to the directory:"), ...draftBox(dialog.draft, "Directory path…")],
				footer: "Enter to submit · Esc to cancel",
			};
		case "rememberDir":
			return {
				lines: [
					paint.fg("accent", paint.bold(text("Add directory to workspace"))),
					"",
					`   ${paint.fg("accent", cutPlainText(dialog.path, width - 4))}`,
					...wrapped("One Code will be able to read files in this directory and make edits when auto-accept edits is on. Auto mode still judges every write there."),
					"",
					...REMEMBER_OPTIONS.map((option, index) => listLine(option, index === dialog.cursor, paint, width)),
					paint.fg("dim", text("Remembered directories are saved to One Code's project settings.")),
				],
				footer: "↑↓ to choose · Enter to confirm · Esc to go back",
			};
		case "removeDir": {
			const dir = workspaceDir(dialog.key, view);
			if (!dir) return gone;
			const details = [`   ${paint.bold(cutPlainText(dir.path, width - 4))}`, paint.fg("dim", cutPlainText(`   ${dir.sourceLabel}`, width - 1))];
			if (!dir.editable) {
				return { lines: [paint.bold(text("Workspace directory")), "", ...details, "", ...(dir.readOnlyNote ? wrapped(dir.readOnlyNote) : [])], footer: "Enter or Esc to go back" };
			}
			return {
				lines: [
					paint.fg("error", paint.bold(text("Remove directory from workspace?"))),
					"",
					...details,
					"",
					text("One Code will no longer have access to files in this directory."),
					...choiceLines(["Yes", "No"], dialog.cursor, paint, width),
				],
				footer: "↑↓ to choose · Enter to confirm · Esc to go back",
			};
		}
	}
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
	if (state.tab === "workspace") return ["↑↓ to navigate · Enter to select · ←/→ to switch tabs · Esc to close"];
	if (state.searching) return ["Type to filter · Enter to select · Backspace to edit · Esc to clear"];
	return ["↑↓ to navigate · Enter to select · Type to search · ←/→ to switch tabs · Esc to close"];
}

export function renderPanel(input: PanelRenderInput, paint: PanelPaint): string[] {
	const { state, view, width, height } = input;
	clampPanelState(state, view);

	const out: string[] = [panelTopRule(paint.fg, width), tabBar(state, paint)];
	if (input.status) out.push(paint.fg("dim", cutPlainText(` ${input.status}`, width - 1)));
	out.push("");

	let footer: string[];
	if (state.dialog) {
		const dialog = dialogLines(state.dialog, input, paint);
		out.push(...dialog.lines);
		footer = [dialog.footer];
	} else {
		let blocks: Block[];
		if (state.tab === "recent") {
			if (view.denials.length === 0) blocks = [{ lines: [paint.fg("dim", cutPlainText(` ${EMPTY_DENIALS}`, width - 1))], selectable: false }];
			else {
				out.push(cutPlainText(" Commands recently denied by the auto mode classifier.", width - 1), "");
				blocks = recentBlocks(input, paint);
			}
		} else if (state.tab === "workspace") {
			out.push(...wrapPlainText(WORKSPACE_SUBTITLE, Math.max(10, width - 2)).map((line) => ` ${line}`), "");
			out.push(`   -  ${cutPlainText(view.workspace.cwd, Math.max(8, width - 32))}${paint.fg("dim", "  (Original working directory)")}`);
			blocks = workspaceBlocks(input, paint);
		} else {
			out.push(...wrapPlainText(SUBTITLES[state.tab], Math.max(10, width - 2)).map((line) => ` ${line}`));
			const placeholder = state.searching ? "Search…" : "Type to search…";
			out.push(...searchBoxLines(state.search[state.tab], placeholder, paint.fg, width));
			blocks = isRuleTab(state.tab) ? ruleBlocks(input, paint, state.tab) : autoBlocks(input, paint);
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
