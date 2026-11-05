/**
 * Diagnostic shaping for the model (pure); the profile's `lsp` group words
 * the lines (text.ts).
 */

import type { LspText, ShownDiagnostic } from "./text.ts";

export interface LspDiagnostic {
	range: { start: { line: number; character: number }; end?: { line: number; character: number } };
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export type SeverityFilter = "error" | "warning" | "all";

/** LSP's severity names (1..4; a missing or unknown severity is treated as error). */
const SEVERITY: Record<number, ShownDiagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function severityName(severity: number | undefined): ShownDiagnostic["severity"] {
	return SEVERITY[severity ?? 1] ?? "error";
}

/** A diagnostic as the texts show it: 1-based position, severity by name. */
export function shownDiagnostic(diagnostic: LspDiagnostic): ShownDiagnostic {
	return {
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		severity: severityName(diagnostic.severity),
		message: diagnostic.message,
		...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
		...(diagnostic.source ? { source: diagnostic.source } : {}),
	};
}

export function filterDiagnostics(diagnostics: LspDiagnostic[], filter: SeverityFilter): LspDiagnostic[] {
	if (filter === "all") return diagnostics;
	const max = filter === "error" ? 1 : 2;
	return diagnostics.filter((d) => (d.severity ?? 1) <= max);
}

/** The tool's result: a summary line, then up to `limit` diagnostics. */
export function formatDiagnostics(relPath: string, diagnostics: LspDiagnostic[], text: LspText["diagnostics"], limit = 20): string {
	if (diagnostics.length === 0) return text.none;
	const shown = diagnostics.slice(0, limit).map((d) => text.line({ path: relPath, diagnostic: shownDiagnostic(d) }));
	if (diagnostics.length > limit) shown.push(text.more(diagnostics.length - limit));
	const summary = text.summary({
		errors: diagnostics.filter((d) => (d.severity ?? 1) === 1).length,
		warnings: diagnostics.filter((d) => d.severity === 2).length,
		total: diagnostics.length,
	});
	return `${summary}\n\n${shown.join("\n")}`;
}
