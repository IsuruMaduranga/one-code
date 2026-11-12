/**
 * Compaction's request limits and the reading of its answer (pure). The
 * profile words the request and the stored summary (text.ts).
 *
 * Claude Code runs the call on the *session's own model* with max_tokens
 * 128000 (findings §47), keeping the system prompt, tools, and message
 * prefix intact, so the provider prompt cache pays for most of the compaction
 * call. The extension does the same; the cap is lowered to the model's output
 * limit and to the room the context window leaves.
 */

export const COMPACTION_MAX_TOKENS = 128_000;

/**
 * The <summary> block is the surviving context; <analysis> is scratch work.
 *
 * Tags are matched at line starts: prose *mentions* the tags — the first live
 * run's analysis said "wrapped in `<analysis>` and `<summary>` tags", the
 * loose regex anchored on that mention, and the stored summary began with the
 * tail of the analysis. Greedy to the last closing tag, so an embedded example
 * cannot truncate the real block. A response without a well-formed block
 * (small models drift) is used whole minus any analysis — losing the whole
 * compaction over a formatting slip would hurt more than untidy text.
 */
export function extractSummary(text: string): string | undefined {
	const lineAnchored = text.match(/^[ \t]*<summary>[ \t]*\n([\s\S]*)\n[ \t]*<\/summary>[ \t]*$/m);
	if (lineAnchored) return lineAnchored[1].trim() || undefined;
	// Loose fallback, only after dropping analysis blocks so an inline mention
	// there cannot become the anchor again.
	const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
	const loose = withoutAnalysis.match(/<summary>([\s\S]*)<\/summary>/);
	if (loose) return loose[1].trim() || undefined;
	return withoutAnalysis.trim() || undefined;
}
