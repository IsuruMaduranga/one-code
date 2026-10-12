/**
 * The write tool's transcript, as Claude Code shows a Write (pure: no pi
 * imports; tool-style/index.ts wires it over pi's write tool).
 *
 * - While the call waits to run (a permission prompt sits under it), the call
 *   line carries a preview of what it will write: the new file's first lines,
 *   or the diff against the file it overwrites. The prompt's decision depends
 *   on it, the way edit's diff preview serves an edit prompt.
 * - Once it ran: `⎿ Wrote N lines to <path>` and the file's first lines for a
 *   new file, `⎿ Added N lines, removed M lines` and the diff for an
 *   overwrite.
 * - Rejected without a reason: `⎿ User rejected write to <path>` and the
 *   first lines it would have written.
 *
 * The content preview stops after WRITE_PREVIEW_LINES lines with a
 * `… +N lines (ctrl+o to expand)` trailer (ctrl+o works inside the prompt
 * too); a diff shows whole, as edit's does. Every line is wrapped to the
 * width, never cut, so nothing in an overwide line hides past the edge.
 */

import { hardWrapColumns } from "../lib/text-width.ts";
import { sanitizeDisplayText } from "../lib/terminal-text.ts";
import {
	callLine,
	displayToolPath,
	EXPAND_HINT,
	elbowIndent,
	linesComponent,
	spinnerBulletColor,
	stripReminderBlocks,
	summarizeArgs,
	textContent,
	type ThemeLike,
	type TuiComponent,
} from "../lib/tui-render.ts";
import { userDenialKind } from "../lib/user-denial.ts";

/** Content lines shown before the `… +N lines` trailer (Claude Code's). */
export const WRITE_PREVIEW_LINES = 10;

/** An overwrite's diff is computed only when both sides are at most this big; past it the result reads as a create. */
export const WRITE_DIFF_MAX_BYTES = 512 * 1024;

/**
 * What a finished write did, on its result's `details` (display-only: tool
 * result details never reach the model). `diff` is pi's display diff
 * (`+12 line`, `-12 line`, ` 12 line`), absent when it was too big to compute.
 */
export type WriteDetails = { kind: "create" } | { kind: "update"; diff?: string };

/** What the waiting call previews: the new content, or the diff against the file on disk. */
export type WritePreview = { kind: "create" } | { kind: "update"; diff: string };

/** Lines in the content, a trailing newline ending the last line rather than starting another (Claude Code's count). */
export function countLines(content: string): number {
	const parts = content.split("\n");
	return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

/** The details a finished write carries: `before` is the file's old content, undefined when it did not exist, null when it was not read. */
export function writeDetails(before: string | null | undefined, content: string, diff: (before: string, after: string) => string): WriteDetails {
	if (before === undefined) return { kind: "create" };
	if (before === null || before.length > WRITE_DIFF_MAX_BYTES || content.length > WRITE_DIFF_MAX_BYTES) return { kind: "update" };
	return { kind: "update", diff: diff(before, content) };
}

/** One source line made safe and wrapped: escapes and control characters removed, tabs as spaces. */
function wrapLine(line: string, width: number): string[] {
	const safe = sanitizeDisplayText(line.replace(/\t/g, "   "));
	return safe === "" ? [""] : hardWrapColumns(safe, Math.max(1, width));
}

/** The content's first lines (all when expanded), wrapped to `width`, with the `… +N lines` trailer. */
export function contentPreviewLines(theme: ThemeLike, content: string, width: number, expanded: boolean): string[] {
	const total = countLines(content);
	const source = (content || "(No content)").split("\n");
	if (content.endsWith("\n")) source.pop();
	const shown = expanded ? source : source.slice(0, WRITE_PREVIEW_LINES);
	const out = shown.flatMap((line) => wrapLine(line, width).map((part) => theme.fg("toolOutput", part)));
	const hidden = total - shown.length;
	if (!expanded && hidden > 0) out.push(theme.fg("dim", `… +${hidden} ${hidden === 1 ? "line" : "lines"} (${EXPAND_HINT})`));
	return out;
}

const DIFF_COLOR: Record<string, string> = { "+": "toolDiffAdded", "-": "toolDiffRemoved" };

/** pi's display diff, each line coloured by its sign and wrapped to `width`. */
export function diffPreviewLines(theme: ThemeLike, diff: string, width: number): string[] {
	if (diff === "") return [];
	return diff.split("\n").flatMap((line) => {
		const color = DIFF_COLOR[line[0]] ?? "toolDiffContext";
		return wrapLine(line, width).map((part) => theme.fg(color, part));
	});
}

/** Added and removed lines in pi's display diff. */
export function diffCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Claude Code's "Added N lines, removed M lines" (either half alone when the other is zero). */
export function updateSummary(theme: ThemeLike, diff: string): string {
	const { added, removed } = diffCounts(diff);
	const plural = (n: number) => (n > 1 ? "lines" : "line");
	const parts: string[] = [];
	if (added > 0) parts.push(`Added ${theme.bold(String(added))} ${plural(added)}`);
	if (removed > 0) parts.push(`${added > 0 ? "r" : "R"}emoved ${theme.bold(String(removed))} ${plural(removed)}`);
	return parts.length > 0 ? parts.join(", ") : "No changes";
}

/** The waiting call's preview body, wrapped to `width`. */
export function writePreviewLines(theme: ThemeLike, preview: WritePreview, content: string, width: number, expanded: boolean): string[] {
	return preview.kind === "update" ? diffPreviewLines(theme, preview.diff, width) : contentPreviewLines(theme, content, width, expanded);
}

/**
 * A finished write's result body, before the `⎿` elbow is added: the summary
 * line, then the content preview or the diff, wrapped to `width`. `path` is
 * the display path.
 */
export function writeResultLines(theme: ThemeLike, details: WriteDetails | undefined, path: string, content: string, width: number, expanded: boolean): string[] {
	if (details?.kind === "update" && details.diff !== undefined) {
		return [updateSummary(theme, details.diff), ...diffPreviewLines(theme, details.diff, width)];
	}
	const head = `Wrote ${theme.bold(String(countLines(content)))} lines to ${theme.bold(sanitizeDisplayText(path))}`;
	return [head, ...contentPreviewLines(theme, content, width, expanded)];
}

/** A write rejected without a reason: "User rejected write to <path>" and the first lines it would have written. */
export function rejectedWriteLines(theme: ThemeLike, path: string, content: string, width: number, expanded: boolean): string[] {
	const head = `${theme.fg("dim", "User rejected write to ")}${theme.bold(theme.fg("dim", sanitizeDisplayText(path)))}`;
	return [head, ...contentPreviewLines(theme, content, width, expanded)];
}

/** The I/O the renderers need, injected so this module stays pure. */
export interface WriteRenderDeps {
	/** The file's content: undefined when it does not exist, null when it cannot or should not be read (too big, a directory). */
	readBefore: (path: string, cwd: string) => Promise<string | null | undefined>;
	/** pi's display diff of two contents. */
	diff: (before: string, after: string) => string;
}

interface WriteArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

/** The waiting call's preview, kept on the row's `context.state` across renders. */
interface PreviewState {
	path: string;
	content: string;
	preview?: WritePreview;
	lines?: { width: number; expanded: boolean; lines: string[] };
}

const argPath = (args: WriteArgs | undefined): string | undefined => {
	const raw = args?.path ?? args?.file_path;
	return typeof raw === "string" && raw !== "" ? raw : undefined;
};

type ResultRenderer = (result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) => TuiComponent;

/**
 * renderCall/renderResult for the write tool. `fallbackResult` renders what
 * this view does not own (an error, a rejection with a reason): the generic
 * wrapper around pi's own result component.
 */
export function createWriteRenderers(
	deps: WriteRenderDeps,
	fallbackResult: ResultRenderer,
): {
	renderShell: "self";
	renderCall: (args: WriteArgs, theme: any, context: any) => TuiComponent;
	renderResult: ResultRenderer;
} {
	/** The preview for these args, starting the read of the target the first time. */
	const previewFor = (path: string, content: string, context: any): PreviewState => {
		const state = context.state as { ccWritePreview?: PreviewState };
		const current = state.ccWritePreview;
		if (current && current.path === path && current.content === content) return current;
		const next: PreviewState = { path, content };
		state.ccWritePreview = next;
		const cwd = typeof context.cwd === "string" ? context.cwd : process.cwd();
		const settle = (preview: WritePreview) => {
			if (state.ccWritePreview !== next) return;
			next.preview = preview;
			context.invalidate?.();
		};
		deps.readBefore(path, cwd).then(
			(before) =>
				settle(
					typeof before === "string" && before.length <= WRITE_DIFF_MAX_BYTES && content.length <= WRITE_DIFF_MAX_BYTES
						? { kind: "update", diff: deps.diff(before, content) }
						: { kind: "create" },
				),
			() => settle({ kind: "create" }),
		);
		return next;
	};

	return {
		renderShell: "self",
		renderCall(args, theme: ThemeLike, context) {
			const path = argPath(args);
			const header = callLine(theme, "Write", path ? summarizeArgs(path) : "", context.isPartial, context.isError, spinnerBulletColor(context));
			const content = args?.content;
			// The preview belongs to the call that has not run yet: once its result
			// is in, the result carries the content (or the diff) instead.
			const waiting = context.isPartial && context.argsComplete && path !== undefined && typeof content === "string";
			const preview = waiting ? previewFor(path, content, context) : undefined;
			const expanded = context.expanded === true;
			return linesComponent((width) => {
				if (!preview?.preview) return [header];
				const cached = preview.lines;
				if (cached && cached.width === width && cached.expanded === expanded) return [header, ...cached.lines];
				const body = writePreviewLines(theme, preview.preview, preview.content, width - 2, expanded).map((line) => `  ${line}`);
				preview.lines = { width, expanded, lines: body };
				return [header, ...body];
			});
		},
		renderResult(result, options, theme: ThemeLike, context) {
			const args = context.args as WriteArgs | undefined;
			const path = argPath(args);
			const content = args?.content;
			if (path === undefined || typeof content !== "string") return fallbackResult(result, options, theme, context);
			const shownPath = displayToolPath(path, context.cwd);
			if (context.isError) {
				if (userDenialKind(textContent(stripReminderBlocks(result))) !== "stop") return fallbackResult(result, options, theme, context);
				return linesComponent((width) => elbowIndent(rejectedWriteLines(theme, shownPath, content, width - 5, options.expanded)));
			}
			const details = result?.details as WriteDetails | undefined;
			return linesComponent((width) => elbowIndent(writeResultLines(theme, details, shownPath, content, width - 5, options.expanded)));
		},
	};
}
