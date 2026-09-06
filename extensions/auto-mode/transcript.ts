/**
 * The `<transcript>` block the classifier reads (pure).
 *
 * Claude Code hands its classifier a compact JSONL transcript of the session —
 * user messages and tool-call *inputs only*, with tool RESULTS stripped so
 * hostile content the agent read cannot reach the classifier as if it were
 * context. Tool names are CC's PascalCase (`Bash`, `Edit`, …). We mirror that
 * shape exactly (see docs/decisions/auto-mode.md, P5).
 *
 * The last entry is always the action under review — permissions/index.ts appends
 * the call being judged before rendering. Results are never appended here; only
 * user messages and tool inputs enter, which is the isolation boundary.
 */

// Native (snake_case) tool name → Claude Code's PascalCase spelling, reused from
// the hooks matcher (its `ccToolName` is the correct-direction, mcp-passthrough
// map; permissions/matcher.ts's is lower-cased and cannot recover casing).
import { ccToolName } from "../hooks/matcher.ts";

export { ccToolName };

/**
 * One line of the transcript: a user message, a tool call's input, or a call the
 * permission rules refused. A `denied` line is harness-generated, never tool
 * output, so it does not weaken the results-stripped isolation boundary — and
 * without it the classifier could not see that the rules had already refused
 * this class of action, so it cleared an equivalent-effect retry on the user's
 * original intent (WEAK-MODEL-REVIEW-2026-09-06 H2).
 */
export type TranscriptEntry =
	| { kind: "user"; text: string }
	| { kind: "tool"; tool: string; input: Record<string, unknown> }
	| { kind: "denied"; tool: string; subject: string; rule: string };

/** Truncate one field so a single huge argument cannot dominate the transcript. */
export function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}… [truncated, ${value.length} chars]`;
}

/** Clip every string leaf of a tool input, leaving structure intact. */
function clipInput(input: Record<string, unknown>, max: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		out[key] = typeof value === "string" ? clip(value, max) : value;
	}
	return out;
}

/**
 * Render one entry as its compact JSON line. Bash renders as `{"Bash":"<command>"}`
 * (the command string, as Claude Code does); every other tool renders as
 * `{"<Tool>":{…input…}}` with string fields clipped.
 */
function renderEntry(entry: TranscriptEntry, maxField: number): string {
	if (entry.kind === "user") return JSON.stringify({ user: clip(entry.text, maxField) });
	if (entry.kind === "denied") {
		return JSON.stringify({
			denied_by_permission_rule: { tool: ccToolName(entry.tool), attempted: clip(entry.subject, maxField), rule: entry.rule },
		});
	}
	const name = ccToolName(entry.tool);
	const command = entry.input.command;
	if (entry.tool === "bash" && typeof command === "string") {
		return JSON.stringify({ [name]: clip(command, maxField) });
	}
	return JSON.stringify({ [name]: clipInput(entry.input, maxField) });
}

export interface RenderOptions {
	/** Max chars per string field. */
	maxField?: number;
	/** Max chars for the whole rendered transcript; oldest entries drop first. */
	maxChars?: number;
}

/**
 * Render the ordered entries into a `<transcript>…</transcript>` block. When the
 * rendered lines exceed `maxChars`, the oldest are dropped and a marker records
 * it — the action under review (the last entry) is always kept. The full user
 * messages are carried separately for intent verification, so dropping old lines
 * here never weakens that check.
 */
export function renderTranscript(entries: TranscriptEntry[], options: RenderOptions = {}): string {
	const maxField = options.maxField ?? 2000;
	const maxChars = options.maxChars ?? 60_000;
	const lines = entries.map((entry) => renderEntry(entry, maxField));

	// Keep the newest lines that fit the budget, walking from the end in one pass
	// (the last line — the action under review — is always kept). +1 per line for
	// the joining "\n".
	let firstKept = lines.length;
	let running = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		running += lines[i].length + 1;
		if (i < lines.length - 1 && running > maxChars) break;
		firstKept = i;
	}
	const kept = lines.slice(firstKept);
	const dropped = firstKept;
	const body = dropped > 0 ? [`{"note":"${dropped} earlier transcript entr${dropped === 1 ? "y" : "ies"} omitted for length"}`, ...kept] : kept;
	return `<transcript>\n${body.join("\n")}\n</transcript>`;
}
