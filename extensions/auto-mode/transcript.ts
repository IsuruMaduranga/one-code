/**
 * The `<transcript>` block the classifier reads (pure).
 *
 * Claude Code hands its classifier a compact JSONL transcript of the session —
 * user messages and tool-call *inputs only*, with tool RESULTS stripped so
 * hostile content the agent read cannot reach the classifier as if it were
 * context. Tool names are CC's PascalCase (`Bash`, `Edit`, …). We mirror that
 * shape exactly (see working-docs/decisions/auto-mode.md, P5).
 *
 * The last entry is always the action under review — permissions/index.ts appends
 * the call being judged before rendering. Results are never appended here; only
 * user messages and tool inputs enter, which is the isolation boundary.
 */

// Native (snake_case) tool name → Claude Code's PascalCase spelling, reused from
// the hooks matcher (its `ccToolName` is the correct-direction, mcp-passthrough
// map; permissions/matcher.ts's is lower-cased and cannot recover casing).
import { ccToolName } from "../hooks/matcher.ts";
// The shell tools render as `{"<Tool>":"<command>"}` (lib/shell-tools.ts is the one list).
import { SHELL_TOOLS } from "../lib/shell-tools.ts";
import type { GitStatusMeta } from "./git-status-meta.ts";
import { RESOLVED_PATHS_NOTE, type ResolvedPathFact } from "./resolved-paths-meta.ts";

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
	 * destroy uncommitted work (auto-mode/git-status-meta.ts): the classifier
	 * reads the tree's real state, not the model's account of it.
	 */
	| { kind: "meta"; gitStatus: GitStatusMeta }
	/**
	 * Harness ground truth, directly above an action that names a path inside
	 * the working directory which resolves outside it through a symlink
	 * (auto-mode/resolved-paths-meta.ts). Not a Claude Code line.
	 */
	| { kind: "resolved-paths"; resolvedPaths: ResolvedPathFact[] };

/** Clip a diagnostic field; classifier transcript entries are never clipped. */
export function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}… [truncated, ${value.length} chars]`;
}

/**
 * Render one entry as its compact JSON line. The shell tools render as
 * `{"Bash":"<command>"}` / `{"PowerShell":"<command>"}` (the command string,
 * as Claude Code does); every other tool renders as `{"<Tool>":{…input…}}`.
 * Keep the input intact, including earlier commands and file contents.
 */
function renderEntry(entry: TranscriptEntry): string {
	if (entry.kind === "user") return JSON.stringify({ user: entry.text });
	if (entry.kind === "summary") return JSON.stringify({ summary: entry.text });
	if (entry.kind === "meta") return JSON.stringify({ meta: { gitStatus: entry.gitStatus } });
	if (entry.kind === "resolved-paths") return JSON.stringify({ meta: { resolvedPaths: entry.resolvedPaths, note: RESOLVED_PATHS_NOTE } });
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

/** Claude Code omits these local read/search calls from prior history. */
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

/** Stable entry boundaries; the pending action and its harness facts stay in the tail. */
export function transcriptBlocks(entries: TranscriptEntry[]): { history: string[]; tail: string } {
	const visible = entries.filter((entry, i) => i === entries.length - 1 || !isHistoricalRead(entry));
	let historyEnd = Math.max(0, visible.length - 1);
	while (historyEnd > 0 && ["meta", "resolved-paths"].includes(visible[historyEnd - 1].kind)) historyEnd--;
	return {
		history: ["<transcript>", ...visible.slice(0, historyEnd).map((entry) => `\n${renderEntry(entry)}`)],
		tail: `\n${visible.slice(historyEnd).map(renderEntry).join("\n")}\n</transcript>`,
	};
}
