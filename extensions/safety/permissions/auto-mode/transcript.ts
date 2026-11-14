/**
 * The `<transcript>` block the classifier reads (pure).
 *
 * Claude Code hands its classifier a compact JSONL transcript of the session —
 * user messages and tool-call *inputs only*, with tool RESULTS stripped so
 * hostile content the agent read cannot reach the classifier as if it were
 * context. Tool names are CC's PascalCase (`Bash`, `Edit`, …). We mirror that
 * shape exactly (see working-docs/decisions/auto-mode.md, P5).
 *
 * The last entry is always the action under review — safety/permissions/index.ts appends
 * the call being judged before rendering. Results are never appended here; only
 * user messages and tool inputs enter, which is the isolation boundary.
 */

// Native (snake_case) tool name → Claude Code's PascalCase spelling, reused from
// the hooks matcher (its `ccToolName` is the correct-direction, mcp-passthrough
// map; lib/rules/matcher.ts's is lower-cased and cannot recover casing).
import { ccToolName } from "../../../lib/rules/hook-matcher.ts";
// The shell tools render as `{"<Tool>":"<command>"}` (lib/shell-run/shell-tools.ts is the one list).
import { SHELL_TOOLS } from "../../../lib/shell-run/shell-tools.ts";
import { indentReport } from "../../../lib/core/text-spans.ts";
import { isPlainObject } from "../../../lib/core/plain-object.ts";
import type { GitStatusMeta } from "./git-status-meta.ts";
import { classifierText } from "./classifier-prompt.ts";
import type { ResolvedPathFact } from "./resolved-paths-meta.ts";

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
	/** Model-generated context, not the user's own words for intent verification. */
	| { kind: "summary"; text: string }
	| { kind: "tool"; tool: string; input: Record<string, unknown> }
	| { kind: "denied"; tool: string; subject: string; rule: string }
	/**
	 * Harness ground truth, the Claude Code-compatible
	 * `{"meta":{"gitStatus":…}}` line, directly above a shell command that can
	 * destroy uncommitted work (safety/permissions/auto-mode/git-status-meta.ts): the classifier
	 * reads the tree's real state, not the model's account of it.
	 */
	| { kind: "meta"; gitStatus: GitStatusMeta }
	/**
	 * Harness ground truth, directly above an action that names a path inside
	 * the working directory which resolves outside it through a symlink
	 * (safety/permissions/auto-mode/resolved-paths-meta.ts). Not a Claude Code line.
	 */
	| { kind: "resolved-paths"; resolvedPaths: ResolvedPathFact[] }
	/**
	 * The last entry of a finished subagent's review: the profile's note, then
	 * the child's final report in `<subagent_hand_back>`, rendered as Claude
	 * Code's `{"user":…}` hand-back line. The ruleset judges "the final entry",
	 * and its SUBAGENT HAND-BACK rule names this entry as that action, so the
	 * model reviews the run and its report rather than the child's last call.
	 * Never the user's words: it never enters `userMessages`, so an intent
	 * quote taken from it fails verification.
	 */
	| { kind: "hand-back"; report: string };

/**
 * One tool call as the classifier sees it, for every path that shows one: the
 * main gate's pending call, a child's gated call, the session's history and a
 * finished subagent's review. Our counterpart of Claude Code's per-tool
 * `toAutoClassifierInput`, so one call never reaches the classifier in two
 * shapes. A shell call is its command as the model wrote it: `asWritten` when
 * the harness has since wrapped the call's own command (a worktree's `cd`
 * wrapper), so the classifier judges what the model asked for and the wrapper
 * does not escalate every call (PERMISSIONS-REVIEW-2026-09-05 L3). Every other
 * tool is its whole input.
 */
export function toolCallEntry(tool: string, input: unknown, asWritten?: string): TranscriptEntry {
	if (asWritten !== undefined) return { kind: "tool", tool, input: { command: asWritten } };
	const args = isPlainObject(input) ? input : {};
	if (SHELL_TOOLS.has(tool) && typeof args.command === "string") return { kind: "tool", tool, input: { command: args.command } };
	return { kind: "tool", tool, input: args };
}

/** Clip a diagnostic field; classifier transcript entries are never clipped. */
export function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}… [truncated, ${value.length} chars]`;
}

/** Line breaks Claude Code folds to `\n` before indenting a report. */
const LINE_BREAKS = /\r\n?|[\u001c-\u001e\u2028\u2029\u0085\v\f]/g;
/** Invisible format characters, dropped so they cannot hide inside a tag name. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * An opening bracket that starts one of the classifier's own tags, however
 * spaced or slashed: it becomes `[`, so a report cannot close the
 * `<transcript>` and write entries of its own. Claude Code does the same
 * for these three names; its bracket set also covers a long table of
 * lookalikes, of which this keeps the ASCII and the common ones.
 */
const TRANSCRIPT_TAG = /[<\uFF1C\uFE64\u2039\u3008\u27E8\u02C2]([\s/\uFF0F\u2215\u2044]*(?:transcript|forwarded_user_turns|forwarded_turn)\b)/giu;

/** The child's report as Claude Code frames it inside `<subagent_hand_back>`: line breaks folded, the classifier's tags defused, every line indented two spaces. */
function handBackReport(report: string): string {
	return indentReport(report.replace(LINE_BREAKS, "\n").replace(INVISIBLE, "").replace(TRANSCRIPT_TAG, "[$1"));
}

/**
 * Render one entry as its compact JSON line. The shell tools render as
 * `{"Bash":"<command>"}` / `{"PowerShell":"<command>"}` (the command string,
 * as Claude Code does); every other tool renders as `{"<Tool>":{…input…}}`.
 * Keep the input intact, including earlier commands and file contents.
 */
function renderEntry(entry: TranscriptEntry): string {
	if (entry.kind === "user") return JSON.stringify({ user: entry.text });
	if (entry.kind === "hand-back") {
		return JSON.stringify({ user: `${classifierText().handBackReview}\n\n<subagent_hand_back>\n${handBackReport(entry.report)}\n</subagent_hand_back>` });
	}
	if (entry.kind === "summary") return JSON.stringify({ summary: entry.text });
	if (entry.kind === "meta") return JSON.stringify({ meta: { gitStatus: entry.gitStatus } });
	if (entry.kind === "resolved-paths") return JSON.stringify({ meta: { resolvedPaths: entry.resolvedPaths, note: classifierText().resolvedPathsNote } });
	if (entry.kind === "denied") {
		return JSON.stringify({
			denied_by_permission_rule: { tool: ccToolName(entry.tool), attempted: entry.subject, rule: entry.rule },
		});
	}
	const name = ccToolName(entry.tool);
	const command = entry.input.command;
	if (SHELL_TOOLS.has(entry.tool) && typeof command === "string") {
		return JSON.stringify({ [name]: command });
	}
	return JSON.stringify({ [name]: entry.input });
}

/**
 * The most characters of the action under review the classifier is sent. That
 * action is never clipped: the tool runs the whole input, so a classifier that
 * saw only its first 2,000 characters cleared a suffix it never read
 * (AUTO-MODE-SECURITY-REVIEW-2026-09-24 M1). A larger action is refused with
 * its size named (classifier.ts), as Claude Code sends the action whole.
 */
export const MAX_ACTION_CHARS = 100_000;

/** The rendered length of the action under review, the last entry, unclipped. */
export function actionLength(entries: readonly TranscriptEntry[]): number {
	const action = entries.at(-1);
	return action ? renderEntry(action).length : 0;
}

/**
 * Claude Code omits these local read/search calls from prior history. Only the
 * session-history projection applies it (history.ts); a rendered transcript
 * keeps every entry it is given, so a finished subagent's reads stay in its
 * hand-back review beside what it did with them.
 */
const HISTORICAL_READ_TOOLS = new Set([
	"Read", "Grep", "Glob", "LSP", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
	"lsp_diagnostics", "tool_search", "list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir",
]);

export function isHistoricalRead(entry: TranscriptEntry): boolean {
	if (entry.kind !== "tool" || !HISTORICAL_READ_TOOLS.has(ccToolName(entry.tool))) return false;
	// CC retains forwarded reads. We do not infer routing authority from an
	// input field, but conservatively retain a named remote destination.
	const host = entry.input._host;
	return typeof host !== "string" || !host.trim() || host.trim() === "container" || host.trim() === "this-machine";
}

/**
 * Render the ordered entries whole, as Claude Code does. A rolling
 * suffix loses the evidence that a cleanup target was created this session;
 * clipping an earlier shell command can hide its redirect or copy destination.
 * If the provider cannot fit the transcript, classification fails closed rather
 * than judging an action with silently missing history.
 */
export function renderTranscript(entries: TranscriptEntry[]): string {
	const { history, tail } = transcriptBlocks(entries);
	return history.join("") + tail;
}

/**
 * Stable entry boundaries; the pending action and its harness facts stay in the
 * tail. Every entry is rendered: what to leave out of the session's history is
 * history.ts's decision, made before the entries get here.
 */
export function transcriptBlocks(entries: TranscriptEntry[]): { history: string[]; tail: string } {
	let historyEnd = Math.max(0, entries.length - 1);
	while (historyEnd > 0 && ["meta", "resolved-paths"].includes(entries[historyEnd - 1].kind)) historyEnd--;
	return {
		history: ["<transcript>", ...entries.slice(0, historyEnd).map((entry) => `\n${renderEntry(entry)}`)],
		tail: `\n${entries.slice(historyEnd).map(renderEntry).join("\n")}\n</transcript>`,
	};
}
