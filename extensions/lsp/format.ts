/**
 * Diagnostic shaping for the model (pure).
 */

export interface LspDiagnostic {
	range: { start: { line: number; character: number }; end?: { line: number; character: number } };
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export type SeverityFilter = "error" | "warning" | "all";

/** LSP severity metadata (1..4; missing severity is treated as error). */
export const SEVERITY: Record<number, { name: string; symbol: string }> = {
	1: { name: "error", symbol: "✘" },
	2: { name: "warning", symbol: "⚠" },
	3: { name: "info", symbol: "ℹ" },
	4: { name: "hint", symbol: "★" },
};

export function severityName(severity: number | undefined): string {
	return SEVERITY[severity ?? 1]?.name ?? "error";
}

export function severitySymbol(severity: number | undefined): string {
	return SEVERITY[severity ?? 1]?.symbol ?? "✘";
}

export function filterDiagnostics(diagnostics: LspDiagnostic[], filter: SeverityFilter): LspDiagnostic[] {
	if (filter === "all") return diagnostics;
	const max = filter === "error" ? 1 : 2;
	return diagnostics.filter((d) => (d.severity ?? 1) <= max);
}

/** One diagnostic as `path:line:col severity: message (code) [source]`, 1-indexed. */
export function formatDiagnostic(relPath: string, diagnostic: LspDiagnostic): string {
	const line = diagnostic.range.start.line + 1;
	const column = diagnostic.range.start.character + 1;
	const code = diagnostic.code !== undefined ? ` (${diagnostic.code})` : "";
	const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
	return `${relPath}:${line}:${column} ${severityName(diagnostic.severity)}: ${diagnostic.message}${code}${source}`;
}

export function formatDiagnostics(relPath: string, diagnostics: LspDiagnostic[], limit = 20): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	const shown = diagnostics.slice(0, limit).map((d) => formatDiagnostic(relPath, d));
	const errors = diagnostics.filter((d) => (d.severity ?? 1) === 1).length;
	const warnings = diagnostics.filter((d) => d.severity === 2).length;
	const counts = [errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""]
		.filter(Boolean)
		.join(", ");
	const omitted = diagnostics.length > limit ? `\n… ${diagnostics.length - limit} more` : "";
	return `${counts || `${diagnostics.length} diagnostics`}\n\n${shown.join("\n")}${omitted}`;
}
