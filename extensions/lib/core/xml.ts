/**
 * XML escaping for text placed inside the harness's tags (pure, no imports,
 * so any module can use it without joining an import cycle).
 */

/** Escapes `& < >` only, as Claude Code's own frames do; quotes stay as typed. */
export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
