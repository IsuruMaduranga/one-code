/**
 * /mcp panel rendering (pure).
 *
 * Returns plain lines already cut to width; the wiring wraps them in a memoized
 * component and applies a final ANSI-aware truncate. Mirrors Claude Code's MCP
 * manager: a grouped server list ("Manage MCP servers") and a per-server detail
 * view (Status / Issue / Auth / URL / Config location + a numbered action list).
 * Only width-1 glyphs are used so cutPlainText's code-point count stays exact.
 */

import { cutPlainText, padPlainText, type RenderBlock as Block, windowBlocks } from "../../lib/tui-render.ts";
import { actionsFor, type McpEntry, statusText } from "./model.ts";
import { clampMcpCursor, detailEntry, type McpPanelState } from "./state.ts";

export interface McpPaint {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface McpRenderInput {
	state: McpPanelState;
	entries: McpEntry[];
	width: number;
	height: number;
	/** Transient messages (auth in progress / URL / errors). */
	notices: string[];
	settled: boolean;
}

function statusFragment(entry: McpEntry, paint: McpPaint): string {
	const { glyph, label, color } = statusText(entry);
	const tools = entry.status === "connected" && entry.toolCount !== undefined ? ` · ${entry.toolCount} tools` : "";
	return `${paint.fg(color, glyph)} ${label}${tools}`;
}

function listBlocks(input: McpRenderInput, paint: McpPaint): Block[] {
	const { state, entries, width } = input;
	const blocks: Block[] = [];
	let lastGroup: string | undefined;
	entries.forEach((entry, i) => {
		if (entry.group !== lastGroup) {
			lastGroup = entry.group;
			blocks.push({ lines: ["", paint.bold(cutPlainText(`  ${entry.group}`, width - 1))], selectable: false });
		}
		const isCursor = i === state.cursor;
		const marker = isCursor ? "❯ " : "  ";
		if (isCursor) {
			// Cursor row is one flat accent highlight, so build it from plain text.
			const { glyph, label } = statusText(entry);
			const tools = entry.status === "connected" && entry.toolCount !== undefined ? ` · ${entry.toolCount} tools` : "";
			const plain = `${marker}${entry.name} · ${glyph} ${label}${tools}`;
			blocks.push({ lines: [paint.fg("accent", cutPlainText(plain, width - 1))], selectable: true });
		} else {
			blocks.push({ lines: [`${marker}${entry.name} · ${statusFragment(entry, paint)}`], selectable: true });
		}
	});
	return blocks;
}

/** Aligns the detail view's value column past the longest label ("Config location:"). */
const LABEL_WIDTH = 18;

function detailLines(input: McpRenderInput, paint: McpPaint): { lines: string[]; footer: string } {
	const { state, entries, width } = input;
	const entry = detailEntry(state, entries);
	if (!entry) return { lines: [paint.fg("dim", "  (server no longer available)")], footer: "Esc to go back" };

	const lines: string[] = [];
	// The value may already carry paint escapes, so it isn't cut here (cutPlainText
	// counts code points, escapes included) — the caller's ANSI-aware truncateLine
	// trims to the real width. Long plain values are pre-cut before painting below.
	const field = (label: string, value: string) => {
		lines.push(` ${paint.bold(padPlainText(`${label}:`, LABEL_WIDTH))}${value}`);
	};

	lines.push(` ${paint.bold(cutPlainText(`${entry.name} MCP Server`, width - 1))}`);
	lines.push("");
	const status = statusText(entry);
	field("Status", `${paint.fg(status.color, status.glyph)} ${status.label}`);
	if (entry.issue) field("Issue", paint.fg("dim", cutPlainText(entry.issue, width - LABEL_WIDTH - 2)));
	if (entry.authState) {
		field(
			"Auth",
			entry.authState === "authenticated"
				? paint.fg("success", "✔ authenticated")
				: paint.fg("error", "✘ not authenticated"),
		);
	}
	if (entry.url) field("URL", paint.fg("dim", entry.url));
	field("Config location", paint.fg("dim", entry.configLocation));
	lines.push("");

	const actions = actionsFor(entry);
	const actionCursor = state.detail?.actionCursor ?? 0;
	actions.forEach((action, i) => {
		const isCursor = i === actionCursor;
		const line = `${isCursor ? "❯ " : "  "}${i + 1}. ${action.label}`;
		lines.push(isCursor ? paint.fg("accent", line) : line);
	});

	return { lines, footer: "↑/↓ to navigate · Enter to select · Esc to back" };
}

export function renderMcpPanel(input: McpRenderInput, paint: McpPaint): string[] {
	const { state, entries, width, height } = input;
	clampMcpCursor(state, entries);

	const out: string[] = [];
	let footer: string;

	if (state.detail) {
		out.push("");
		const detail = detailLines(input, paint);
		out.push(...detail.lines);
		footer = detail.footer;
	} else {
		out.push(` ${paint.bold("Manage MCP servers")}`);
		const count = `${entries.length} server${entries.length === 1 ? "" : "s"}${input.settled ? "" : " · connecting…"}`;
		out.push(paint.fg("dim", cutPlainText(` ${count}`, width - 1)));

		const footerReserve = 3 + input.notices.length + 1;
		const budget = Math.max(1, height - out.length - footerReserve);
		if (entries.length === 0) {
			out.push("", paint.fg("dim", "  No MCP servers configured. Add them to .mcp.json or ~/.claude.json."));
		} else {
			const windowed = windowBlocks(listBlocks(input, paint), state.cursor, budget);
			out.push(...windowed.lines);
			if (windowed.more > 0) out.push(paint.fg("dim", `  ↓ ${windowed.more} more`));
		}
		out.push("");
		out.push(paint.fg("dim", cutPlainText("  Servers are configured in .mcp.json or ~/.claude.json.", width - 1)));
		footer = "↑/↓ to navigate · Enter to confirm · Esc to cancel";
	}

	for (const notice of input.notices) {
		for (const line of notice.split("\n")) out.push(paint.fg("warning", cutPlainText(`  ${line}`, width - 1)));
	}
	out.push("");
	out.push(paint.fg("dim", cutPlainText(` ${footer}`, width - 1)));
	return out;
}
