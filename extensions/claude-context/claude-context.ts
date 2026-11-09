/**
 * Claude Code's three first-message context reminders: the instructions block
 * (the instruction files and the MEMORY.md index), the context block (the
 * user's email and the git snapshot) and the date, each its own
 * `<system-reminder>` (see extensions/claude-context for the wiring, and
 * lib/reminders.ts for placement; on a model that takes a mid-conversation
 * system message the date moves into it, lib/system-role.ts). Which files the
 * instructions block carries is lib/instructions.ts.
 *
 * This module is pure (no pi imports) and byte-exact with Claude Code. The
 * blocks are identical across model tiers — only the `# Memory` *spec* in the
 * system prompt varies by tier (handled in lib/memory.ts), never these blocks.
 *
 * ONECODE.md files ride their OWN `# oneCodeMd` block (`buildOneCodeBlock`),
 * emitted after the instructions block so they take precedence over it,
 * keeping that block byte-exact with Claude Code.
 */

import { type ContextFile, instructionTargets, MEMORY_DESCRIPTOR } from "../lib/instructions.ts";
import { contextWords } from "../lib/context-words.ts";

/** Claude Code's `nested_memory` rendering (the reminder queue adds the `<system-reminder>` frame). */
export function nestedInstructionText(file: { path: string; content: string }): string {
	return contextWords().nestedFile({ path: file.path, content: file.content });
}

/** The block's preamble, naming the files above it: AGENTS.md in independent mode (lib/sources.ts). */
function productPreamble(): string {
	return contextWords().productPreamble({ above: instructionTargets().project });
}

/**
 * Assemble the `# oneCodeMd` block's inner text (wrapper added by lib/reminders.ts):
 * the precedence preamble, then one `Contents of {path} ({descriptor}):\n\n{content}`
 * section per file (same raw-content join as the claudeMd block). Returns null when
 * there are no ONECODE.md files, so nothing extra rides when the feature is unused.
 */
export function buildOneCodeBlock(files: ContextFile[]): string | null {
	if (files.length === 0) return null;
	return withoutFinalNewline(`${productPreamble()}\n\n${files.map(section).join("\n")}`);
}

/**
 * One file's section. Its content is raw, but always ends in a newline: the
 * join rule relies on it, and a file without one would glue the next section,
 * or the next section's header, onto its last line.
 */
function section(file: ContextFile): string {
	const content = file.content.endsWith("\n") ? file.content : `${file.content}\n`;
	const words = contextWords();
	return words.section({ path: file.path, source: file.descriptor, content });
}

/**
 * The date reminder's value: the user's LOCAL calendar date as YYYY-MM-DD, the
 * date their own clock shows (a UTC date is a day off every evening west of
 * UTC and every early morning east of it).
 */
export function localDate(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Claude Code's notice when the local date moves on mid-session. The block
 * carrying the date is frozen after the first request, so the new date
 * rides a one-shot where the model reads next, the way Claude Code does.
 */
export function dateChangeReminder(date: string): string {
	return contextWords().dateChanged({ date });
}

/** The text without one trailing newline: the reminder frame supplies the newline before its closing tag. */
function withoutFinalNewline(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * The instructions block's inner text (the `<system-reminder>` wrapper is added
 * by lib/reminders.ts):
 *
 *   {PREAMBLE}\n\n
 *   {section}\n{section}\n…{last section without its final newline}
 *
 * where each section is `Contents of {path} ({descriptor}):\n\n{content}` and
 * `content` keeps its own trailing newline (files are read raw, never trimmed —
 * a file ending in "\n" plus the join "\n" is the "\n\n" seen between
 * sections). A file that does not end in "\n" gets one, so no header lands on
 * its last line. `memoryIndex`, when present, is appended as a final section
 * with the memory descriptor. Returns null when there is nothing to inject.
 */
export function buildClaudeMdBlock(opts: {
	contextFiles: ContextFile[];
	memoryIndex?: { path: string; content: string } | null;
}): string | null {
	const sections = [...opts.contextFiles];
	if (opts.memoryIndex && opts.memoryIndex.content.trim()) {
		sections.push({
			path: opts.memoryIndex.path,
			content: opts.memoryIndex.content,
			descriptor: MEMORY_DESCRIPTOR,
		});
	}
	if (sections.length === 0) return null;
	return withoutFinalNewline(`${contextWords().instructionsPreamble}\n\n${sections.map(section).join("\n")}`);
}

/**
 * The context block's inner text: the preamble, `# userEmail` with Claude
 * Code's use-only-to-identify sentence, the `# gitStatus` snapshot
 * (lib/git-status.ts), then a blank line and the footer. Null with neither an
 * email nor a snapshot.
 */
export function buildContextBlock(opts: { email?: string | null; gitStatus?: string | null }): string | null {
	const words = contextWords();
	const parts: string[] = [];
	if (opts.email) parts.push(words.email({ email: opts.email }));
	if (opts.gitStatus) parts.push(opts.gitStatus);
	if (parts.length === 0) return null;
	return `${words.contextPreamble}\n${parts.join("\n")}\n\n${words.contextFooter}`;
}

/** The date reminder's inner text, sent whether or not any CLAUDE.md exists. */
export function dateBlock(date: string): string {
	return contextWords().date({ date });
}
