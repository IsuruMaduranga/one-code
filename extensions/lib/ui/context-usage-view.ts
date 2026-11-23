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
	/** Where project agents live, the custom-agents section's note (the profile's project config folder plus `agents/`). */
	agentsDir?: string;
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

/** Claude Code's order of agent groups: Project, User, then each plugin by name. */
const GROUP_ORDER = ["Project", "User"];

/** `items` by group in Claude Code's order, each group's items as they came (largest first). */
function byGroup(items: readonly ContextItem[]): Array<[string, ContextItem[]]> {
	const groups = new Map<string, ContextItem[]>();
	for (const item of items) {
		const group = item.group ?? "";
		const members = groups.get(group);
		if (members) members.push(item);
		else groups.set(group, [item]);
	}
	const rank = (group: string) => {
		const at = GROUP_ORDER.indexOf(group);
		return at >= 0 ? at : GROUP_ORDER.length;
	};
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
	const heading = (title: string, note: string) => `${INDENT}${bold(title)}${dim(` · ${note}`)}`;
	const sum = (items: readonly ContextItem[]) => items.reduce((total, item) => total + item.tokens, 0);
	const { loaded, available } = usage.mcp;
	const mcpNote = `/mcp${available.length > 0 ? " (loaded on-demand)" : ""}`;
	const hasMcp = loaded.length > 0 || available.length > 0;
	const agentsNote = options.agentsDir ?? "agents/";
	// A transcript entry drawn by a build before custom agents had no `agents`.
	const agents = usage.agents ?? [];
	const hasLists = hasMcp || agents.length > 0 || usage.memoryFiles.length > 0 || usage.skills.length > 0;
	if (options.collapsed) {
		// The category's row, so the summary matches the legend after the provider's count rescales the rows.
		const categoryTokens = (key: ContextCategoryKey) => usage.categories.find((row) => row.key === key)?.tokens;
		const summary = (title: string, note: string, items: readonly unknown[], noun: string, tokens: number) =>
			items.length === 0 ? [] : ["", heading(title, note), `${INDENT}${dim(`└ ${items.length} ${noun}${items.length === 1 ? "" : "s"} · ${formatContextTokens(tokens)} tokens`)}`];
		out.push(
			...summary("MCP tools", mcpNote, [...loaded, ...available], "tool", sum(loaded)),
			...summary("Custom agents", agentsNote, agents, "agent", categoryTokens("agents") ?? sum(agents)),
			...summary("Memory files", "/memory", usage.memoryFiles, "file", sum(usage.memoryFiles)),
			// Claude Code counts the whole skills listing here (the category's row), not the sum of the skills' shares.
			...summary("Skills", "/skills", usage.skills, "skill", categoryTokens("skills") ?? sum(usage.skills)),
		);
		if (hasLists) out.push("", `${INDENT}${dim("/context all to expand")}`);
		return out;
	}
	// Claude Code runs the lists after MCP's together; the first list still gets a blank line above it.
	if (!hasMcp && hasLists) out.push("");
	if (hasMcp) {
		out.push("", heading("MCP tools", mcpNote));
		if (loaded.length > 0) out.push("", `${INDENT}${dim("Loaded")}`, ...tree(loaded.map((item) => sized(item))).map((line) => `${INDENT}${line}`));
		if (available.length > 0) out.push("", `${INDENT}${dim("Available")}`, ...tree(available).map((line) => `${INDENT}${dim(line)}`));
	}
	if (agents.length > 0) {
		out.push(heading("Custom agents", agentsNote));
		for (const [group, items] of byGroup(agents)) out.push(`${INDENT}${dim(group)}`, ...tree(items.map((item) => sized(item))).map((line) => `${INDENT}${line}`));
	}
	if (usage.memoryFiles.length > 0) {
		out.push(heading("Memory files", "/memory"), ...tree(usage.memoryFiles.map((item) => sized(item))).map((line) => `${INDENT}${line}`));
	}
	if (usage.skills.length > 0) {
		// Claude Code rounds a skill's share to tens and marks it approximate.
		const rounded = usage.skills.map((item) => ({ ...item, tokens: Math.max(10, Math.round(item.tokens / 10) * 10) }));
		out.push(heading("Skills", "/skills"), ...tree(rounded.map((item) => sized(item, "~"))).map((line) => `${INDENT}${line}`));
	}
	return out;
}

/** Rows each table of the report keeps before its "and N more" row. */
const REPORT_ROWS = 10;

/** `items` capped at REPORT_ROWS, largest first, and the row that sums the rest ("" when nothing is cut). */
function capped<T extends { tokens: number }>(items: readonly T[], tokens: (n: number) => string): { kept: readonly T[]; more: string } {
	if (items.length <= REPORT_ROWS) return { kept: items, more: "" };
	const sorted = [...items].sort((a, b) => b.tokens - a.tokens);
	const rest = sorted.slice(REPORT_ROWS);
	return { kept: sorted.slice(0, REPORT_ROWS), more: `| and ${rest.length} more |  | ${tokens(rest.reduce((sum, item) => sum + item.tokens, 0))} |\n` };
}

/** A skill's share as Claude Code's report prints it: approximate, to tens. */
const skillTokens = (tokens: number) => (tokens < 20 ? "< 20" : `~${formatContextTokens(Math.round(tokens / 10) * 10)}`);

/** The server of an MCP tool's `mcp__<server>__<tool>` name. */
const mcpServer = (name: string) => name.split("__")[1] ?? "";

/**
 * What the model reads for `/context`: Claude Code 2.1.330's Markdown report
 * (findings §101), the same in every presentation, while the screen above is
 * the user's alone. Each table keeps its largest ten rows. A skill's source is
 * known only for a plugin's (its `plugin:` prefix), and an MCP tool not loaded
 * has no size here, so the servers' table counts tools only.
 */
export function contextReport(usage: ContextUsage): string {
	const tokens = formatContextTokens;
	const share = (n: number) => `${((n / Math.max(1, usage.window)) * 100).toFixed(1)}%`;
	let out = "## Context Usage\n\n";
	out += `**Model:** ${usage.model.id || usage.model.name}  \n`;
	out += usage.total === undefined ? `**Tokens:** ? / ${tokens(usage.window)}\n` : `**Tokens:** ${tokens(usage.total)} / ${tokens(usage.window)} (${Math.round((usage.total / Math.max(1, usage.window)) * 100)}%)\n`;
	if (usage.total !== undefined && usage.total > usage.window) out += `**Over limit:** Context exceeds the ${tokens(usage.window)}-token limit by ${tokens(usage.total - usage.window)} tokens — run /compact or /clear to continue.\n`;
	out += "\n";
	const note = usage.preview !== undefined && usage.estimateError === undefined ? "This token count is an estimate." : contextNote(usage);
	if (note) out += `${note}\n\n`;
	const rows = usage.categories.filter((row) => row.tokens > 0);
	if (rows.length > 0) {
		out += "### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n";
		for (const row of rows) out += `| ${row.name} | ${tokens(row.tokens)} | ${share(row.tokens)} |\n`;
		if (usage.free !== undefined && usage.free > 0) out += `| Free space | ${tokens(usage.free)} | ${share(usage.free)} |\n`;
		if (usage.buffer > 0) out += `| Autocompact buffer | ${tokens(usage.buffer)} | ${share(usage.buffer)} |\n`;
		out += "\n";
	}
	const table = <T extends { tokens: number }>(title: string, head: string, rule: string, items: readonly T[], row: (item: T) => string, format = tokens) => {
		if (items.length === 0) return;
		const { kept, more } = capped(items, format);
		out += `### ${title}\n\n${head}\n${rule}\n${kept.map((item) => `${row(item)}\n`).join("")}${more}\n`;
	};
	table("MCP Tools", "| Tool | Server | Tokens |", "|------|--------|--------|", usage.mcp.loaded, (item) => `| ${item.name} | ${mcpServer(item.name)} | ${tokens(item.tokens)} |`);
	const servers = new Map<string, number>();
	for (const name of usage.mcp.available) servers.set(mcpServer(name), (servers.get(mcpServer(name)) ?? 0) + 1);
	if (servers.size > 0) {
		const ranked = [...servers].sort((a, b) => b[1] - a[1]);
		const kept = ranked.slice(0, REPORT_ROWS);
		const rest = ranked.slice(REPORT_ROWS);
		out += "### Other MCP tools, by server\n\n| Server | Tools |\n|--------|-------|\n";
		out += kept.map(([server, count]) => `| ${server} | ${count} |\n`).join("");
		if (rest.length > 0) out += `| and ${rest.length} more | ${rest.reduce((sum, [, count]) => sum + count, 0)} |\n`;
		out += "\n";
	}
	table("Custom Agents", "| Agent Type | Source | Tokens |", "|------------|--------|--------|", usage.agents ?? [], (item) => `| ${item.name} | ${item.group?.startsWith("Plugin") ? "Plugin" : (item.group ?? "")} | ${tokens(item.tokens)} |`);
	table("Memory Files", "| Type | Path | Tokens |", "|------|------|--------|", usage.memoryFiles, (item) => `| ${item.group ?? "Project"} | ${item.name} | ${tokens(item.tokens)} |`);
	if ((usage.categories.find((row) => row.key === "skills")?.tokens ?? 0) > 0) {
		const plugin = (name: string) => (name.includes(":") ? `Plugin (${name.slice(0, name.indexOf(":"))})` : "");
		table("Skills", "| Skill | Source | Tokens |", "|-------|--------|--------|", usage.skills, (item) => `| ${item.name} | ${plugin(item.name)} | ${skillTokens(item.tokens)} |`, skillTokens);
	}
	return out;
}
