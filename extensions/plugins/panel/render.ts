/**
 * /plugins panel rendering (pure).
 *
 * Returns plain lines already cut to width; the wiring wraps them in a
 * memoized component and applies a final ANSI-aware truncate (pi-tui crashes
 * on overwide lines, so both layers guard).
 */

import { formatInstallCount } from "../counts.ts";
import { cutPlainText, panelTopRule, type RenderBlock as Block, searchBoxLines, windowBlocks } from "../../lib/tui-render.ts";
import type { DiscoverRow, InstalledRow } from "./rows.ts";
import { clampPanelState, type PanelState, type PanelView, resolveDetail, selectableRows, TABS, type Tab } from "./state.ts";

export interface PanelPaint {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
}

/** Detail-view extras the row model doesn't carry (from the marketplace manifest). */
export interface DiscoverDetail {
	version?: string;
	author?: string;
	category?: string;
	contributions: string[];
}

export interface PanelRenderInput {
	state: PanelState;
	view: PanelView;
	width: number;
	height: number;
	/** Active async operations, e.g. "cloning claude-plugins-official…". */
	loading: string[];
	discoverDetails: Map<string, DiscoverDetail>;
	restartNeeded: boolean;
}

export const TRUST_NOTE =
	"Make sure you trust a plugin before installing or enabling it: plugins can run commands, add MCP servers, and start language servers on your machine. One Code does not review plugin content — check the plugin's homepage and source.";

const TAB_TITLES: Record<Tab, string> = {
	discover: "Discover",
	installed: "Installed",
	marketplaces: "Marketplaces",
	errors: "Errors",
};

function tabBar(state: PanelState, view: PanelView, paint: PanelPaint, width: number): string {
	const chips = TABS.map((tab) => {
		const title = tab === "errors" && view.errors.length > 0 ? `${TAB_TITLES[tab]} (${view.errors.length})` : TAB_TITLES[tab];
		return tab === state.tab ? paint.inverse(` ${title} `) : ` ${title} `;
	});
	return ` ${paint.bold("Plugins")} ${chips.join(" ")}`.slice(0, width * 4);
}

function discoverBlocks(input: PanelRenderInput, paint: PanelPaint): Block[] {
	const { state, view, width } = input;
	const cursorRow = selectableRows(state, view)[state.cursor.discover];
	return view.discover.map((row) => {
		const isCursor = row === cursorRow;
		const marker = isCursor ? "❯" : " ";
		const dot = row.busy ? "…" : row.installed ? "●" : "○";
		const installs = row.installs !== undefined ? ` · ${formatInstallCount(row.installs)} installs` : "";
		const head = cutPlainText(`${marker} ${dot} ${row.name} · ${row.marketplace}${installs}`, width - 1);
		const painted = isCursor ? paint.fg("accent", head) : head;
		const lines = [painted];
		if (row.description) lines.push(paint.fg("dim", cutPlainText(`    ${row.description}`, width - 1)));
		return { lines, selectable: true };
	});
}

function installedLine(row: Exclude<InstalledRow, { kind: "section" }>, paint: PanelPaint): string {
	const on = paint.fg("success", "✔");
	const off = paint.fg("error", "✘");
	if (row.kind === "plugin") {
		const state = row.busy ? "…" : row.enabled ? `${on} enabled` : `${off} disabled`;
		const override = row.overridden ? " · One Code override" : "";
		const marketplace = row.marketplace ? ` · ${row.marketplace}` : "";
		return `${row.name} Plugin${marketplace} · ${state}${override}`;
	}
	if (row.kind === "mcp") {
		const status =
			row.status === "connected"
				? `${on} connected${row.toolCount !== undefined ? ` (${row.toolCount} tools)` : ""}`
				: row.status === "authNeeded"
					? paint.fg("warning", `⚠ needs auth${row.detail ? ` — ${row.detail}` : ""}`)
					: row.status === "connecting"
						? "… connecting"
						: `${off} failed${row.detail ? ` — ${row.detail}` : ""}`;
		return `${row.name} MCP · ${status}`;
	}
	const toggle = row.enabled ? `${on} on` : `${off} off`;
	return `${row.name} Skill · ${row.scope} · ${toggle} · ~${row.tokens} tok · ${row.recency}`;
}

function installedBlocks(input: PanelRenderInput, paint: PanelPaint): Block[] {
	const { state, view, width } = input;
	const cursorRow = selectableRows(state, view)[state.cursor.installed];
	return view.installed.map((row) => {
		if (row.kind === "section") {
			return { lines: ["", paint.bold(cutPlainText(` ${row.title}`, width - 1))], selectable: false };
		}
		const isCursor = row === cursorRow;
		const marker = isCursor ? "❯ " : "  ";
		const line = `${marker}${installedLine(row, paint)}`;
		return { lines: [isCursor ? paint.fg("accent", line) : line], selectable: true };
	});
}

function marketplaceBlocks(input: PanelRenderInput, paint: PanelPaint): Block[] {
	const { state, view, width } = input;
	const cursorRow = selectableRows(state, view)[state.cursor.marketplaces];
	return view.marketplaces.map((row) => {
		const isCursor = row === cursorRow;
		const marker = isCursor ? "❯" : "●";
		if (row.kind === "add") {
			const line = `${isCursor ? "❯" : " "} + Add Marketplace`;
			return { lines: [isCursor ? paint.fg("accent", line) : paint.bold(line), ""], selectable: true };
		}
		const star = row.official ? paint.fg("error", " ✳ ") : " ";
		const name = `${marker}${star}${paint.bold(row.name)}${row.official ? paint.fg("error", " ✳") : ""}`;
		const counts = [
			row.available !== undefined ? `${row.available} available` : "not synced",
			`${row.installedCount} installed`,
			`Updated ${row.updated.slice(0, 10)}`,
		].join(" • ");
		const lines = [
			isCursor ? paint.fg("accent", cutPlainText(name, width * 2)) : cutPlainText(name, width * 2),
			paint.fg("dim", cutPlainText(`   ${row.sourceLine}`, width - 1)),
			paint.fg("dim", cutPlainText(`   ${counts}`, width - 1)),
		];
		if (row.error) lines.push(paint.fg("error", cutPlainText(`   ${row.error}`, width - 1)));
		lines.push("");
		return { lines, selectable: true };
	});
}

function addDialogLines(draft: string, paint: PanelPaint, width: number): string[] {
	const inner = Math.max(30, Math.min(width - 4, 78));
	const border = (ch: string) => `┌${ch.repeat(inner)}┐`;
	const boxLine = (text: string, style?: (t: string) => string) => {
		const cut = cutPlainText(text, inner - 2);
		const padded = ` ${cut}${" ".repeat(Math.max(0, inner - 2 - cut.length))} `;
		return `│${style ? style(padded) : padded}│`;
	};
	return [
		border("─"),
		boxLine("Add Marketplace", paint.bold),
		boxLine(""),
		boxLine("Enter marketplace source:"),
		boxLine(draft ? draft : "…", draft ? undefined : (t) => paint.fg("dim", t)),
		boxLine(""),
		boxLine("Examples:", (t) => paint.fg("dim", t)),
		boxLine("· owner/repo (GitHub)", (t) => paint.fg("dim", t)),
		boxLine("· git@github.com:owner/repo.git (SSH)", (t) => paint.fg("dim", t)),
		boxLine("· https://example.com/marketplace.json", (t) => paint.fg("dim", t)),
		boxLine("· ./path/to/marketplace", (t) => paint.fg("dim", t)),
		`└${"─".repeat(inner)}┘`,
	];
}

function detailLines(input: PanelRenderInput, paint: PanelPaint): { lines: string[]; footer: string } {
	const { state, view, width } = input;
	const ref = state.detail;
	const row = ref ? resolveDetail(ref, view) : undefined;
	if (!ref || !row) return { lines: [paint.fg("dim", "  (no longer available)")], footer: "Esc to go back" };

	const lines: string[] = [];
	const push = (text: string, style?: (t: string) => string) => {
		const cut = cutPlainText(text, width - 2);
		lines.push(style ? ` ${style(cut)}` : ` ${cut}`);
	};

	if (ref.kind === "discover") {
		const discover = row as DiscoverRow;
		const detail = input.discoverDetails.get(discover.id);
		push(`${discover.name} · ${discover.marketplace}`, paint.bold);
		if (discover.description) push(discover.description);
		push("");
		if (detail?.version) push(`Version: ${detail.version}`, (t) => paint.fg("dim", t));
		if (detail?.author) push(`Author: ${detail.author}`, (t) => paint.fg("dim", t));
		if (detail?.category) push(`Category: ${detail.category}`, (t) => paint.fg("dim", t));
		if (discover.installs !== undefined) push(`${formatInstallCount(discover.installs)} installs`, (t) => paint.fg("dim", t));
		if (detail?.contributions.length) {
			push("");
			push("Provides:", paint.bold);
			for (const item of detail.contributions) push(`· ${item}`);
		}
		push("");
		for (const noteLine of wrapNote(TRUST_NOTE, width - 4)) push(noteLine, (t) => paint.fg("warning", t));
		const footer = discover.busy
			? "working…"
			: discover.installed
				? "u to uninstall · Esc to go back"
				: "i to install · Esc to go back";
		return { lines, footer };
	}

	if ("kind" in row && row.kind === "plugin") {
		push(`${row.name} Plugin${row.marketplace ? ` · ${row.marketplace}` : ""}`, paint.bold);
		push(`Origin: ${row.origin === "one-code" ? "installed by One Code" : "installed by Claude Code (read-only files)"}`);
		push(`State: ${row.enabled ? "enabled" : "disabled"}${row.overridden ? " (One Code override)" : ""}`);
		push("");
		for (const noteLine of wrapNote(TRUST_NOTE, width - 4)) push(noteLine, (t) => paint.fg("warning", t));
		const uninstall = row.origin === "one-code" ? " · u to uninstall" : "";
		const overrideNote = row.origin === "claude" ? " (One Code override — Claude Code settings untouched)" : "";
		return { lines, footer: `Space/e/d to toggle${overrideNote}${uninstall} · f to favorite · Esc to go back` };
	}

	if ("kind" in row && row.kind === "skill") {
		push(`${row.name} Skill · ${row.scope}`, paint.bold);
		push(`State: ${row.enabled ? "on" : "off"} · ~${row.tokens} tok · ${row.recency}`);
		return { lines, footer: "Space/e/d to toggle · f to favorite · Esc to go back" };
	}

	if ("kind" in row && row.kind === "mcp") {
		push(`${row.name} MCP server`, paint.bold);
		push(`Status: ${row.status}${row.detail ? ` — ${row.detail}` : ""}`);
		if (row.source) push(`Source: ${row.source}`, (t) => paint.fg("dim", t));
		return { lines, footer: "Esc to go back" };
	}

	return { lines, footer: "Esc to go back" };
}

function wrapNote(text: string, width: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current && current.length + word.length + 1 > Math.max(20, width)) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

const FOOTERS: Record<Tab, string> = {
	discover: "Type to search · Space to install/uninstall · Enter to view · ←/→ tabs · Esc to close",
	installed: "Type to search · Space to toggle · Enter to view · ←/→ tabs · Esc to close",
	marketplaces: "Enter to select · a to add · u to update · d to remove · Esc to close",
	errors: "←/→ tabs · Esc to close",
};

export function renderPanel(input: PanelRenderInput, paint: PanelPaint): string[] {
	const { state, view, width, height } = input;
	clampPanelState(state, view);

	const out: string[] = [panelTopRule(paint.fg, width), tabBar(state, view, paint, width), ""];
	let footer: string;

	if (state.addDialog) {
		out.push(...addDialogLines(state.addDialog.draft, paint, width));
		footer = "Enter to add · Esc to cancel";
	} else if (state.detail) {
		const detail = detailLines(input, paint);
		out.push(...detail.lines);
		footer = detail.footer;
	} else {
		let blocks: Block[];
		switch (state.tab) {
			case "discover": {
				const total = view.discover.length;
				const position = total === 0 ? 0 : state.cursor.discover + 1;
				out.push(paint.bold(cutPlainText(` Discover plugins (${position}/${total})`, width - 1)), "");
				out.push(...searchBoxLines(state.search.discover, "Search…", paint.fg, width), "");
				blocks = discoverBlocks(input, paint);
				break;
			}
			case "installed": {
				out.push(...searchBoxLines(state.search.installed, "Search…", paint.fg, width));
				blocks = installedBlocks(input, paint);
				break;
			}
			case "marketplaces": {
				out.push(paint.bold(" Manage marketplaces"), "");
				blocks = marketplaceBlocks(input, paint);
				break;
			}
			case "errors": {
				blocks = view.errors.length
					? view.errors.map((error) => ({ lines: [cutPlainText(`  ${error}`, width - 1)], selectable: true }))
					: [{ lines: [paint.fg("dim", "  No plugin errors")], selectable: false }];
				break;
			}
		}
		const budget = Math.max(3, height - out.length - 3);
		const windowed = windowBlocks(blocks, state.cursor[state.tab], budget);
		out.push(...windowed.lines);
		if (windowed.more > 0) out.push(paint.fg("dim", `  ↓ more below (${windowed.more})`));
		footer = FOOTERS[state.tab];
	}

	for (const loading of input.loading) out.push(paint.fg("dim", cutPlainText(`  ${loading}`, width - 1)));
	if (state.notice) out.push(paint.fg("warning", cutPlainText(`  ${state.notice}`, width - 1)));
	if (input.restartNeeded) {
		out.push(
			paint.fg(
				"warning",
				cutPlainText("  Some changes (MCP servers, agents, hooks) apply on the next session restart.", width - 1),
			),
		);
	}
	out.push("", paint.fg("dim", cutPlainText(` ${footer}`, width - 1)));
	return out;
}
