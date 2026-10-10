/**
 * MEMORY.md and memory-file content: Claude Code's index load limits and
 * truncation, and the frontmatter stamp written into memory files. Kept apart
 * from `memory.ts`, whose path helpers most extensions import, so only the
 * memory and doctor extensions load the YAML and instruction parsers.
 */

import { isMap, isScalar, parseDocument, visit } from "yaml";
import { parseRule } from "./claude-rules.ts";

/**
 * Claude Code loads only the first 200 lines or 25,000 characters of
 * MEMORY.md, whichever comes first, and tells the model what it cut (see
 * `truncateIndex`). Mirror that so an overgrown index behaves identically
 * here. The limits are measured against what actually loads: YAML frontmatter
 * and block-level HTML comments are stripped first, and surrounding
 * whitespace does not count. Claude Code measures string length, not UTF-8
 * bytes.
 */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_CHARS = 25_000;

/** The index uses Claude Code's instruction parser before applying its load limits. */
export function loadableIndexContent(content: string): string {
	return parseRule(content).content;
}

/** Line and character counts of the index as the limits measure it. */
function indexSize(loadable: string): { trimmed: string; lines: number; chars: number } {
	const trimmed = loadable.trim();
	return { trimmed, lines: trimmed.split("\n").length, chars: trimmed.length };
}

/**
 * The index as it loads. Within the limits it is the loadable content as is.
 * Past either limit it is cut the way Claude Code cuts it: to the first 200
 * lines, then back to the last line break within 25,000 characters, followed
 * by Claude Code's warning line naming what was cut, so the model knows the
 * index goes on. The result ends in a newline, so the next section of the
 * context block starts on a line of its own.
 */
export function truncateIndex(content: string): string {
	const loadable = loadableIndexContent(content);
	const { trimmed, lines, chars } = indexSize(loadable);
	const overLines = lines > INDEX_MAX_LINES;
	const overChars = chars > INDEX_MAX_CHARS;
	if (!overLines && !overChars) return loadable;

	let kept = overLines ? trimmed.split("\n").slice(0, INDEX_MAX_LINES).join("\n") : trimmed;
	if (kept.length > INDEX_MAX_CHARS) {
		const lastBreak = kept.lastIndexOf("\n", INDEX_MAX_CHARS);
		kept = kept.slice(0, lastBreak > 0 ? lastBreak : INDEX_MAX_CHARS);
	}
	const keptLines = trimmed[kept.length] === "\n" ? kept.split("\n").length : 0;
	const nextStart = kept.length + 1;
	const nextEnd = trimmed.indexOf("\n", nextStart);
	const nextLine = trimmed.slice(nextStart, nextEnd < 0 ? undefined : nextEnd).trim();
	const cut =
		keptLines === 0
			? `everything after the first ${kept.length} characters of line 1 was cut off`
			: `${lines - keptLines} of ${lines} lines were cut off, starting at line ${keptLines + 1}${nextLine ? ` ("${shortenLine(nextLine, 80)}")` : ""}`;
	const size =
		overChars && !overLines
			? `${formatSize(chars)} (limit: ${formatSize(INDEX_MAX_CHARS)}) \u2014 index entries are too long`
			: overLines && !overChars
				? `${lines} lines (limit: ${INDEX_MAX_LINES})`
				: `${lines} lines and ${formatSize(chars)}`;
	return `${kept}\n\n> WARNING: MEMORY.md is ${size}. Only part of it was loaded: ${cut}. Keep index entries to one line under ~200 chars; move detail into topic files.\n`;
}

/** A size the way Claude Code prints it: `N bytes`, else `N.NKB`/`MB` with a trailing `.0` dropped. */
function formatSize(n: number): string {
	const units = ["KB", "MB", "GB"];
	let value = n / 1024;
	if (value < 1) return `${n} bytes`;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
}

/** Claude Code's quote of the first cut line: at most `max` characters, cut at a word when that keeps over half. */
function shortenLine(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = [...text].slice(0, max - 1).join("");
	const lastSpace = head.search(/\s\S*$/);
	const atWord = lastSpace === -1 ? "" : head.slice(0, lastSpace).trimEnd();
	return `${atWord.length > max / 2 ? atWord : head.trimEnd()}\u2026`;
}

/**
 * Where the index stands against its load limits, checked after each write so
 * the model hears about an overgrown index while it can still fix it (Claude
 * Code behaves the same: near-limit reminder, over-limit error — the write
 * itself always succeeds).
 */
export function indexLimitStatus(content: string): "ok" | "near" | "over" {
	const { lines, chars } = indexSize(loadableIndexContent(content));
	if (lines > INDEX_MAX_LINES || chars > INDEX_MAX_CHARS) return "over";
	if (lines >= INDEX_MAX_LINES * 0.9 || chars >= INDEX_MAX_CHARS * 0.9) return "near";
	return "ok";
}

export const INDEX_NEAR_LIMIT_REMINDER = `MEMORY.md is approaching its load limit (only the first ${INDEX_MAX_LINES} lines or 25KB are loaded each session). Shorten it now: keep one line per entry, move detail into topic files in the memory directory, and merge or drop stale entries.`;

export const INDEX_OVER_LIMIT_ERROR = `MEMORY.md is over its load limit (${INDEX_MAX_LINES} lines / 25KB): everything past the limit is dropped the next time it is loaded. The write succeeded, but rewrite the index now — one line per entry, move detail into topic files, merge or drop stale entries.`;

/**
 * Stamp safe YAML memory headers, retaining the originating session on updates.
 * Claude Code's ue/Mt preserve originSessionId; Dn declines unsafe rewrites.
 * Keep comments, flow mappings, BOM/CRLF and the body; leave malformed headers,
 * aliases and non-mapping metadata untouched rather than losing user content.
 */
export function stampFrontmatter(content: string, sessionId: string, modifiedIso: string): string {
	if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(content)) return content;
	const match = content.match(/^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
	if (!match) return content;

	// Claude Code checks its permissive parser against strict delimiters before
	// rewriting: a quoted value containing "---" can make the header ambiguous.
	const parsedBoundary = content.replace(/^\uFEFF/, "").match(/^---\s*\n([\s\S]*?)---\s*\n?/);
	if (parsedBoundary?.[1].trim() !== match[2].trim()) return content;

	const document = parseDocument(match[2]);
	if (document.errors.length || document.warnings.length || !isMap(document.contents)) return content;
	let hasAlias = false;
	visit(document, { Alias: () => { hasAlias = true; } });
	if (hasAlias) return content;

	if (document.get("metadata") == null) document.set("metadata", document.createNode({}));
	const metadata = document.get("metadata", true);
	if (!isMap(metadata)) return content;

	metadata.set("node_type", "memory");
	const nodeIndex = metadata.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "node_type");
	metadata.items.unshift(...metadata.items.splice(nodeIndex, 1));
	const origin = metadata.get("originSessionId");
	if (typeof origin !== "string" || !origin) metadata.set("originSessionId", sessionId);
	metadata.set("modified", modifiedIso);

	let yaml = document.toString().replace(/\n$/, "");
	if (match[1].endsWith("\r\n")) yaml = yaml.replaceAll("\n", "\r\n");
	return match[1] + yaml + match[3] + content.slice(match[0].length);
}
