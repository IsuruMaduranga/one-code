/**
 * Fix hints a profile declares for its own language server's diagnostics
 * (`ProductLanguageServer.fixHints`, lib/profile/language-servers.ts), and the
 * trailer that shows them (pure). A diagnostic from that server is tagged
 * with its hint where the servers' maps merge (index.ts); the
 * `<new-diagnostics>` block and the `lsp_diagnostics` result then end with
 * one line per distinct hint, after their own caps and cut, so the
 * diagnostics stay bounded as Claude Code bounds them and a hint is never
 * cut. The profile words the trailer (`LspText.fixHints`). Claude Code has
 * nothing like it: a session whose servers declare no hints sends the same
 * text as before.
 */

import type { ResolvedFixHints } from "../../lib/profile/language-servers.ts";
import type { LspDiagnostic } from "./format.ts";
import type { LspText } from "./text.ts";

/** A server's hints, as the profile resolved them. */
export type FixHints = ResolvedFixHints;

/** A diagnostic's hint and what it is shown under: its code, or the substring that matched its message. */
export interface FixHint {
	key: string;
	hint: string;
}

/**
 * At most this many hint lines per block or result. A hint is advice and
 * the diagnostics above it are the facts, so the rest are dropped, first
 * seen first kept, in the order the diagnostics are shown (errors first).
 */
export const MAX_FIX_HINTS = 10;

/** The hint for `diagnostic` from `hints`: its code first, then the first substring its message contains. */
export function fixHintFor(diagnostic: LspDiagnostic, hints: FixHints): FixHint | undefined {
	if (diagnostic.code !== undefined) {
		const key = String(diagnostic.code);
		const hint = hints.byCode.get(key);
		if (hint !== undefined) return { key, hint };
	}
	for (const [substring, hint] of hints.byMessage) {
		if (diagnostic.message.includes(substring)) return { key: substring, hint };
	}
	return undefined;
}

/** `diagnostics` each tagged with its hint; the same array when none has one, so a server without hints costs nothing. */
export function withFixHints(diagnostics: LspDiagnostic[], hints: FixHints | undefined): LspDiagnostic[] {
	if (!hints) return diagnostics;
	let tagged: LspDiagnostic[] | undefined;
	diagnostics.forEach((diagnostic, index) => {
		const fixHint = fixHintFor(diagnostic, hints);
		if (!fixHint) return;
		tagged ??= [...diagnostics];
		tagged[index] = { ...diagnostic, fixHint };
	});
	return tagged ?? diagnostics;
}

/** The trailer for the diagnostics shown, in the profile's words; undefined when none carries a hint or the profile words none. */
export function fixHintTrailer(shown: readonly LspDiagnostic[], words: LspText["fixHints"]): string | undefined {
	if (!words) return undefined;
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const { fixHint } of shown) {
		if (!fixHint) continue;
		const id = `${fixHint.key}\n${fixHint.hint}`;
		if (seen.has(id)) continue;
		seen.add(id);
		if (lines.length === MAX_FIX_HINTS) break;
		lines.push(words.line(fixHint));
	}
	return lines.length > 0 ? `${words.heading}\n${lines.join("\n")}` : undefined;
}
