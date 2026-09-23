/**
 * The doctor report (pure): the data shape every check writes into, and the
 * plain-text renderer both the `/doctor` panel and the `onecode doctor` CLI
 * print from.
 *
 * Shape follows Claude Code's `claude doctor` terminal diagnostics — titled
 * sections of `└ label: value` lines, a warnings block, one closing verdict —
 * extended with what a One Code user actually needs on a first session and
 * Claude Code never has to explain: which provider is ready, which model each
 * role (main, subagents, classifier, reader) resolves to and why, what of the
 * imported Claude Code configuration is honoured, and which external programs
 * are missing. Rationale: docs/decisions/doctor.md.
 *
 * No pi imports. The wiring (index.ts, cli.ts) gathers the live inputs and hands
 * them to `buildDoctorReport`; everything below is deterministic given them.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { tildify } from "../lib/paths.ts";
import type { McpStatusEvent } from "../lib/mcp-status.ts";
import { wrapProse } from "../lib/tui-render.ts";
import { countNoun } from "../lib/tui-render.ts";
export { countNoun };

export type LineLevel = "ok" | "info" | "warn" | "error" | "dim";

export interface ReportLine {
	text: string;
	level?: LineLevel;
	/** Nesting depth: 0 = `└ ` item, 1 = `  └ ` sub-item, 2 = deeper. */
	indent?: number;
}

export interface ReportSection {
	title: string;
	lines: ReportLine[];
	/** A dim trailer under the title (scope, hint). */
	subtitle?: string;
}

export interface Finding {
	level: "warn" | "error";
	text: string;
	/** What to do about it, when known. Rendered as a `Fix:` line. */
	fix?: string;
}

export interface DoctorReport {
	title: string;
	/** Two or three plain sentences a first-time user can act on. */
	summary: string;
	sections: ReportSection[];
	findings: Finding[];
	/** False when an error-level finding means a session cannot do useful work yet. */
	ready: boolean;
}

/** Everything the environment tells the doctor without touching pi's registry. */
export interface DoctorEnvironment {
	cwd: string;
	home: string;
	/** pi's live agent dir (honours PI_CODING_AGENT_DIR — the app isolates to ~/.onecode/agent). */
	agentDir: string;
	/** One Code's own state dir (~/.onecode or ONECODE_STATE_DIR). */
	stateDir: string;
	env: NodeJS.ProcessEnv;
	platform: string;
	arch: string;
	nodeVersion: string;
	oneCodeVersion: string;
	/** How One Code was launched: the bundled `onecode` app or the extension on the user's own pi. */
	install: "app" | "pi-package";
	piVersion?: string;
	/** Result of the registry lookup for the newest release, when one was attempted. */
	latest?: { status: "current" | "behind" | "unknown" | "skipped"; version?: string; reason?: string };
}

/** The slice of pi's ModelRegistry the checks read — structural so tests and the CLI can supply it. */
export interface RegistryView {
	/** Every catalog row, authenticated or not (`getAll()`). */
	all: Model<Api>[];
	/** Rows the user has working credentials for (`getAvailable()`). */
	available: Model<Api>[];
	authStatus(provider: string): { configured: boolean; source?: string; label?: string };
	displayName?(provider: string): string;
}

/** Live session facts; the CLI fills what it can from settings and leaves the rest undefined. */
export interface SessionView {
	model?: Model<Api>;
	/** Where `model` came from: the running session, pi's saved default, or nowhere. */
	modelSource: "session" | "default-setting" | "first-available" | "none";
	thinkingLevel?: string;
	permission?: { mode: string; classifier?: string; pinned?: boolean; source?: string };
	mcp?: McpStatusEvent;
}

export const REPORT_TITLE = "One Code doctor";

const GLYPH: Record<LineLevel, string> = { ok: "✔", info: "", warn: "⚠", error: "✘", dim: "" };

export interface RenderOptions {
	width?: number;
	/** Theme painter; identity when absent (the CLI prints plain text). */
	paint?: (color: string, text: string) => string;
	bold?: (text: string) => string;
}

const COLOR: Record<LineLevel, string> = { ok: "success", info: "text", warn: "warning", error: "error", dim: "dim" };

/** Resolve the optional painters once; identity when absent (the CLI prints plain text). */
function painters(options: RenderOptions) {
	return {
		width: Math.max(20, options.width ?? 100),
		paint: options.paint ?? ((_color: string, text: string) => text),
		bold: options.bold ?? ((text: string) => text),
	};
}

type Paint = (color: string, text: string) => string;

/**
 * One `└ `-style entry: the glyph for its level, word-wrapped to `width`, with
 * continuation lines aligned under the text (past the bullet and the glyph) so a
 * 300-char path never produces an overwide line (pi-tui crashes on one).
 */
function renderEntry(prefix: string, text: string, level: LineLevel | undefined, width: number, paint: Paint): string[] {
	const glyph = level ? GLYPH[level] : "";
	const lead = glyph ? `${glyph} ` : "";
	return wrapProse(text, Math.max(10, width - prefix.length - lead.length)).map((segment, i) => {
		const head = i === 0 ? `${prefix}${lead}` : " ".repeat(prefix.length + lead.length);
		return head + (level ? paint(COLOR[level], segment) : segment);
	});
}

/** One section — title, optional dim subtitle, its `└ ` lines — rendered standalone (the `/doctor presets` listing). */
export function renderSection(section: ReportSection, options: RenderOptions = {}): string[] {
	const { width, paint, bold } = painters(options);
	const out: string[] = [bold(section.title) + (section.subtitle ? paint("dim", ` — ${section.subtitle}`) : "")];
	if (section.lines.length === 0) out.push(paint("dim", "└ (nothing)"));
	for (const line of section.lines) out.push(...renderEntry(`${"  ".repeat(line.indent ?? 0)}└ `, line.text, line.level, width, paint));
	return out;
}

/** Render the whole report to lines no wider than `width`, Claude Code's `└ ` style. */
export function renderDoctorReport(report: DoctorReport, options: RenderOptions = {}): string[] {
	const { width, paint, bold } = painters(options);
	const out: string[] = [bold(report.title), ...wrapProse(report.summary, width)];
	for (const section of report.sections) out.push("", ...renderSection(section, options));
	out.push("");
	if (report.findings.length === 0) {
		out.push(paint("success", "No setup issues found."));
		return out;
	}
	const errors = report.findings.filter((f) => f.level === "error").length;
	const warns = report.findings.length - errors;
	out.push(bold(`Issues (${[errors ? countNoun(errors, "problem") : "", warns ? countNoun(warns, "warning") : ""].filter(Boolean).join(", ")})`));
	for (const finding of report.findings) {
		out.push(...renderEntry("└ ", finding.text, finding.level, width, paint));
		if (finding.fix) out.push(...renderEntry("  ", `Fix: ${finding.fix}`, "dim", width, paint));
	}
	return out;
}

/** Plain-text form for `ctx.ui.notify`, `-p` output and the CLI. */
export function renderDoctorText(report: DoctorReport, width = 100): string {
	return renderDoctorReport(report, { width }).join("\n");
}

/** `$3/M in · $15/M out`, or `unpriced` when the catalog carries no usable price. */
export function priceLabel(model: Model<Api>): string {
	const input = model.cost?.input;
	const output = model.cost?.output;
	if (typeof input !== "number" || input <= 0) return "unpriced";
	return typeof output === "number" && output > 0 ? `$${input}/M in · $${output}/M out` : `$${input}/M in`;
}

/** `1M`, `200k`, `32k` — a context window as users read it. */
export function contextLabel(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "";
	if (tokens >= 1_000_000) return `${Number.isInteger(tokens / 1_000_000) ? tokens / 1_000_000 : (tokens / 1_000_000).toFixed(1)}M context`;
	return `${Math.round(tokens / 1000)}k context`;
}

/** `~/…` for anything under home, so paths stay readable at any width. */
export function shortenHome(path: string, home: string): string {
	return tildify(path, home);
}
