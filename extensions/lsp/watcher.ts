/**
 * Session-wide new-diagnostics delta (pure).
 *
 * The way Claude Code surfaces language-server feedback: every diagnostic the
 * servers have published is diffed against a delivered-set, and only genuinely
 * new ones are injected into the conversation — cross-file (an edit to one
 * file surfaces the dependents it broke), all severities, deduplicated by
 * content so an unchanged diagnostic is never repeated. Editing a file clears
 * its delivered-set, so an issue that was fixed and reintroduced resurfaces.
 *
 * Caps match Claude Code's: 10 diagnostics per file, 30 total, 4000 chars,
 * errors surviving truncation first; the delivered-set is bounded to the 500
 * most-recently-touched files.
 *
 * One deliberate divergence: file headers are cwd-relative paths, not
 * basenames — two files with the same basename would otherwise be
 * indistinguishable in one block (docs/decisions/lsp.md).
 */

import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type LspDiagnostic, severitySymbol } from "./format.ts";

export const MAX_PER_FILE = 10;
export const MAX_TOTAL = 30;
export const MAX_CHARS = 4000;
const MAX_TRACKED_FILES = 500;

/** Content identity of one diagnostic — stable across repeated publishes. */
export function fingerprintDiagnostic(d: LspDiagnostic): string {
	return JSON.stringify({
		m: d.message,
		s: d.severity ?? null,
		r: d.range,
		o: d.source ?? null,
		c: d.code ?? null,
	});
}

/**
 * Per-file delivered fingerprints, LRU-bounded by file count. Insertion order
 * doubles as recency: touching a file re-inserts it at the back.
 */
export class DeliveredTracker {
	private files = new Map<string, Set<string>>();

	constructor(private readonly maxFiles = MAX_TRACKED_FILES) {}

	/** Forget a file (called when it is edited) so its issues can resurface. */
	clear(uri: string): void {
		this.files.delete(uri);
	}

	delivered(uri: string): Set<string> | undefined {
		return this.files.get(uri);
	}

	markDelivered(uri: string, fingerprints: Iterable<string>): void {
		const existing = this.files.get(uri) ?? new Set<string>();
		this.files.delete(uri); // re-insert at the back = most recently touched
		for (const fp of fingerprints) existing.add(fp);
		this.files.set(uri, existing);
		while (this.files.size > this.maxFiles) {
			const oldest = this.files.keys().next().value;
			if (oldest === undefined) break;
			this.files.delete(oldest);
		}
	}
}

/**
 * Diagnostics not yet delivered, per uri. Pure read — nothing is committed
 * until `markDelivered(delta, tracker)` after a successful send.
 */
export function computeDelta(
	all: Map<string, LspDiagnostic[]>,
	tracker: DeliveredTracker,
): Map<string, LspDiagnostic[]> {
	const delta = new Map<string, LspDiagnostic[]>();
	for (const [uri, diagnostics] of all) {
		if (diagnostics.length === 0) continue;
		const seen = tracker.delivered(uri);
		const fresh = seen ? diagnostics.filter((d) => !seen.has(fingerprintDiagnostic(d))) : diagnostics;
		if (fresh.length > 0) delta.set(uri, fresh);
	}
	return delta;
}

export function markDelivered(delta: Map<string, LspDiagnostic[]>, tracker: DeliveredTracker): void {
	for (const [uri, diagnostics] of delta) {
		tracker.markDelivered(uri, diagnostics.map(fingerprintDiagnostic));
	}
}

function entryLine(d: LspDiagnostic): string {
	const line = d.range.start.line + 1;
	const column = d.range.start.character + 1;
	const code = d.code !== undefined ? ` [${d.code}]` : "";
	const source = d.source ? ` (${d.source})` : "";
	return `  ${severitySymbol(d.severity)} [Line ${line}:${column}] ${d.message}${code}${source}`;
}

function displayPath(uri: string, cwd: string): string {
	let path = uri;
	try {
		path = fileURLToPath(uri);
	} catch {
		// Not a file uri; show it verbatim.
	}
	return relative(cwd, path) || path;
}

/**
 * The `<new-diagnostics>` block, or undefined for an empty delta. Layout:
 * opening tag runs straight into the preamble, one blank line before the
 * first file section and between sections, entries two-space indented.
 */
export function formatNewDiagnostics(delta: Map<string, LspDiagnostic[]>, cwd: string): string | undefined {
	if (delta.size === 0) return undefined;

	interface FileSection {
		path: string;
		diagnostics: LspDiagnostic[];
		omitted: number;
		worst: number;
	}

	const total = [...delta.values()].reduce((n, list) => n + list.length, 0);
	const sections: FileSection[] = [...delta.entries()].map(([uri, list]) => {
		const sorted = [...list].sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1));
		const kept = sorted.slice(0, MAX_PER_FILE);
		return {
			path: displayPath(uri, cwd),
			diagnostics: kept,
			omitted: sorted.length - kept.length,
			worst: kept[0]?.severity ?? 1,
		};
	});
	sections.sort((a, b) => a.worst - b.worst || a.path.localeCompare(b.path));

	const parts: string[] = [];
	let included = 0;
	for (const section of sections) {
		if (included >= MAX_TOTAL) break;
		const room = MAX_TOTAL - included;
		const kept = section.diagnostics.slice(0, room);
		included += kept.length;
		parts.push(`${section.path}:\n${kept.map(entryLine).join("\n")}`);
	}
	const omitted = total - included;
	if (omitted > 0) parts.push(`… ${omitted} more`);

	let body = parts.join("\n\n");
	if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}…[truncated]`;

	return `<new-diagnostics>The following new diagnostic issues were detected:\n\n${body}\n</new-diagnostics>`;
}
