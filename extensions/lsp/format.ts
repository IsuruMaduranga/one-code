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

const SEVERITY_NAMES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function severityName(severity: number | undefined): string {
	return SEVERITY_NAMES[severity ?? 1] ?? "error";
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
