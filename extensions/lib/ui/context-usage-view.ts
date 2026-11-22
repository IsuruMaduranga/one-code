/**
 * `/context`'s screen, as lines: Claude Code 2.1.330's layout
 * (working-docs/features/ui-parity/evidence/screens/cc-05-context*.txt). The
 * result row "⎿  Context usage", the grid with its legend beside it (model
 * name, model id, the total, "Estimated usage by category" and a row per
 * category, then free space and the autocompact buffer), the auto-compact
 * window, and the per-item lists (MCP tools loaded and available, memory
 * files, skills), or with `collapsed` one count-and-tokens row per list and
 * the "/context all to expand" hint (Claude Code's fullscreen presentation,
 * `collapseDetailSections`). With an identity `paint` the lines are the plain text RPC,
 * one-shot runs and the command's stdout get.
 *
 * The grid follows Claude Code's sizes (`gridSize`), 5 columns under 80. When
 * the legend still does not fit beside it (a long model id on a narrow
 * terminal), it goes under the grid instead.
 *
 * Pure: no pi imports.
 */

import { type ContextCategoryKey, type ContextItem, type ContextUsage, contextGrid, formatContextPercent, formatContextTokens } from "../context/context-usage.ts";
import { visibleWidth } from "./text-width.ts";
import { sanitizeTitle } from "./terminal-text.ts";
import { wrapProse } from "./tui-render.ts";

/**
 * Theme colours per category, after Claude Code's: grays for the system
 * prompt and tools, cyan for MCP tools, the brand colour for memory files,
 * amber for skills, violet for messages. Claude Code's colour for MCP server
 * instructions is not in the evidence; blue is our choice, and the syntax type
 * colour for custom agents (lavender in Claude Code's screen).
 */
const CATEGORY_COLORS: Record<ContextCategoryKey, string> = {
	systemPrompt: "muted",
	systemTools: "dim",
	mcpTools: "mdCode",
	mcpInstructions: "mdLink",
	agents: "syntaxType",
	memory: "accent",
	skills: "warning",
	messages: "syntaxNumber",
};

/** The cell glyphs: a full or partial category cell, free space, and the buffer. */
const GLYPHS = { full: "⛁", partial: "⛀", free: "⛶", buffer: "⛝" } as const;

/** Claude Code shows a cell full from this fullness up. */
const FULL_FROM = 0.7;

/** Indent of everything under the `⎿` elbow. */
const INDENT = "     ";
/** Columns between the grid and its legend. */
const GAP = "   ";

/** Under this many terminal columns Claude Code uses its narrow grid. */
const NARROW_BELOW = 80;

export interface ContextViewOptions {
	width: number;
	/** Each list as one count-and-tokens row plus a "/context all to expand" hint, as Claude Code shows them in fullscreen. */
	collapsed?: boolean;
	paint?: (color: string, text: string) => string;
	bold?: (text: string) => string;
}

/** The note under the legend when the rows are not a measurement of the current context. */
export function contextNote(usage: ContextUsage): string | undefined {
	// No diagnostics log exists for a swallowed error, so the one place it shows is here.
	if (usage.estimateError !== undefined) return `The estimate failed: ${sanitizeTitle(usage.estimateError)}`;
	if (usage.state === "empty") return "Nothing sent yet in this session; the breakdown appears after the next reply.";
	if (usage.state === "compacted") return "Compacted since the last request; the breakdown appears after the next reply.";
	if (usage.preview === "first") return "Estimated from what the next request will send: nothing sent yet.";
	if (usage.preview === "compaction") return "Estimated from what the next request will send: nothing sent since the compaction.";
	if (usage.unreconciled !== undefined) return `Rows are estimates: the provider counted ${formatContextTokens(usage.unreconciled)} tokens for the last request.`;
	return undefined;
}

/** Claude Code's order of agent groups: Project, User, then each plugin by name, then anything else. */
const GROUP_ORDER = ["Project", "User"];

/** `items` by group in Claude Code's order, each group's items as they came (largest first). */
function byGroup(items: readonly ContextItem[]): Array<[string, ContextItem[]]> {
	const groups = new Map<string, ContextItem[]>();
	for (const item of items) {
		const group = item.group ?? "";
		groups.set(group, [...(groups.get(group) ?? []), item]);
	}
	const rank = (group: string) => (GROUP_ORDER.includes(group) ? GROUP_ORDER.indexOf(group) : group.startsWith("Plugin") ? GROUP_ORDER.length : GROUP_ORDER.length + 1);
	return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A tree list: `├` for every item but the last, which takes `└`. */
function tree(items: readonly string[]): string[] {
	return items.map((item, index) => `${index === items.length - 1 ? "└" : "├"} ${item}`);
}

/** The lines of `/context`'s result, the `⎿` row first. */
export function renderContextUsage(usage: ContextUsage, options: ContextViewOptions): string[] {
	const paint = options.paint ?? ((_color: string, text: string) => text);
	const bold = options.bold ?? ((text: string) => text);
	const dim = (text: string) => paint("dim", text);
	const window = formatContextTokens(usage.window);
	const pct = (tokens: number) => formatContextPercent(tokens, usage.window);

	const legend: string[] = [
		usage.model.name,
		dim(usage.model.id),
		dim(usage.total === undefined ? `?/${window} tokens` : `${formatContextTokens(usage.total)}/${window} tokens (${Math.round((usage.total / Math.max(1, usage.window)) * 100)}%)`),
		"",
		dim("Estimated usage by category"),
		...usage.categories.map((row) => `${paint(CATEGORY_COLORS[row.key], GLYPHS.full)} ${row.name}: ${dim(`${formatContextTokens(row.tokens)} tokens (${pct(row.tokens)}%)`)}`),
		...(usage.free !== undefined ? [`${dim(GLYPHS.free)} Free space: ${dim(`${formatContextTokens(usage.free)} tokens (${pct(usage.free)}%)`)}`] : []),
		...(usage.buffer > 0 ? [`${dim(GLYPHS.buffer)}${dim(` Autocompact buffer: ${formatContextTokens(usage.buffer)} tokens (${pct(usage.buffer)}%)`)}`] : []),
	];

	const narrow = options.width < NARROW_BELOW;
	const grid = contextGrid(usage, narrow).map((row) =>
		row
			.map((cell) =>
				cell.kind === "free"
					? dim(GLYPHS.free)
					: cell.kind === "buffer"
						? dim(GLYPHS.buffer)
						: paint(CATEGORY_COLORS[cell.kind], cell.fullness >= FULL_FROM ? GLYPHS.full : GLYPHS.partial),
			)
			.join(" "),
	);
	const gridWidth = grid.length > 0 ? visibleWidth(grid[0]) : 0;
	const legendWidth = Math.max(0, ...legend.map(visibleWidth));
	const beside = INDENT.length + gridWidth + GAP.length + legendWidth <= options.width;

	const out: string[] = [`  ${dim("⎿")}  Context usage`];
	if (beside) {
		const blank = " ".repeat(gridWidth);
		const rows = Math.max(grid.length, legend.length);
		for (let i = 0; i < rows; i++) {
			const text = legend[i] ?? "";
			out.push(text ? `${INDENT}${grid[i] ?? blank}${GAP}${text}` : `${INDENT}${grid[i] ?? ""}`);
		}
	} else {
		for (const row of grid) out.push(`${INDENT}${row}`);
		out.push("");
		for (const text of legend) out.push(text ? `${INDENT}${text}` : "");
	}

	const note = contextNote(usage);
	if (note) out.push("", ...wrapProse(note, options.width - INDENT.length).map((line) => `${INDENT}${dim(line)}`));
	if (usage.buffer > 0) out.push("", `${INDENT}Auto-compact window:  ${window} tokens`);

	const sized = (item: ContextItem, prefix = "") => `${item.name}: ${dim(`${prefix}${formatContextTokens(item.tokens)} tokens`)}`;
	const { loaded, available } = usage.mcp;
	const hasMcp = loaded.length > 0 || available.length > 0;
	const agents = usage.agents ?? [];
	const agentsNote = usage.agentsDir ?? "agents/";
	const hasLists = hasMcp || agents.length > 0 || usage.memoryFiles.length > 0 || usage.skills.length > 0;
	if (options.collapsed) {
		const sum = (items: readonly ContextItem[]) => items.reduce((total, item) => total + item.tokens, 0);
		const summary = (title: string, note: string, count: number, noun: string, tokens: number) => [
			"",
			`${INDENT}${bold(title)}${dim(` · ${note}`)}`,
			`${INDENT}${dim(`└ ${count} ${noun}${count === 1 ? "" : "s"} · ${formatContextTokens(tokens)} tokens`)}`,
		];
		if (hasMcp) out.push(...summary("MCP tools", `/mcp${available.length > 0 ? " (loaded on-demand)" : ""}`, loaded.length + available.length, "tool", sum(loaded)));
		if (agents.length > 0) out.push(...summary("Custom agents", agentsNote, agents.length, "agent", sum(agents)));
		if (usage.memoryFiles.length > 0) out.push(...summary("Memory files", "/memory", usage.memoryFiles.length, "file", sum(usage.memoryFiles)));
		// Claude Code counts the whole skills listing here (the category's row), not the sum of the skills' shares.
		const skillTokens = usage.categories.find((row) => row.key === "skills")?.tokens ?? sum(usage.skills);
		if (usage.skills.length > 0) out.push(...summary("Skills", "/skills", usage.skills.length, "skill", skillTokens));
		if (hasLists) out.push("", `${INDENT}${dim("/context all to expand")}`);
		return out;
	}
	// Claude Code runs the lists after MCP's together; the first list still gets a blank line above it.
	if (!hasMcp && hasLists) out.push("");
	if (hasMcp) {
		out.push("", `${INDENT}${bold("MCP tools")}${dim(` · /mcp${available.length > 0 ? " (loaded on-demand)" : ""}`)}`);
		if (loaded.length > 0) out.push("", `${INDENT}${dim("Loaded")}`, ...tree(loaded.map((item) => sized(item))).map((line) => `${INDENT}${line}`));
		if (available.length > 0) out.push("", `${INDENT}${dim("Available")}`, ...tree(available).map((line) => `${INDENT}${dim(line)}`));
	}
	if (agents.length > 0) {
		out.push(`${INDENT}${bold("Custom agents")}${dim(` · ${agentsNote}`)}`);
		for (const [group, items] of byGroup(agents)) out.push(`${INDENT}${dim(group)}`, ...tree(items.map((item) => sized(item))).map((line) => `${INDENT}${line}`));
	}
	if (usage.memoryFiles.length > 0) {
		out.push(`${INDENT}${bold("Memory files")}${dim(" · /memory")}`, ...tree(usage.memoryFiles.map((item) => sized(item))).map((line) => `${INDENT}${line}`));
	}
	if (usage.skills.length > 0) {
		// Claude Code rounds a skill's share to tens and marks it approximate.
		const rounded = usage.skills.map((item) => ({ ...item, tokens: Math.max(10, Math.round(item.tokens / 10) * 10) }));
		out.push(`${INDENT}${bold("Skills")}${dim(" · /skills")}`, ...tree(rounded.map((item) => sized(item, "~"))).map((line) => `${INDENT}${line}`));
	}
	return out;
}
