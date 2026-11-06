/**
 * What the first-message context needs from a profile (types only): the
 * words of the instructions block, the context block (email, git status),
 * the date lines, the environment block and model line, and the notes about
 * instruction files left out for size. The base finds the files, reads git
 * and the environment, decides what changed and what is too large; the
 * section headers (`# claudeMd`, `# oneCodeMd`, `# userEmail`,
 * `# gitStatus`, `# Environment`) are part of the words.
 */

import type { EnvironmentFacts } from "./environment-block.ts";
import type { GitSnapshot } from "./git-status.ts";

/** Where an instruction file comes from; the key a section's descriptor is worded by. */
export type InstructionSource = "global" | "managed" | "project" | "local" | "memory" | "oneCode" | "oneCodeGlobal" | "agents";

/** What changed in the workspace since the context block was told. */
export type ContextChange = "git" | "memory" | "instructions";

/** How far a MEMORY.md index is over its limits (sizes already formatted). */
export type MemoryIndexSize =
	| { kind: "chars"; size: string; limit: string }
	| { kind: "lines"; lines: number; limit: number }
	| { kind: "both"; lines: number; size: string };

/** What of a MEMORY.md index was not loaded; `next` is the first line cut, shortened. */
export type MemoryIndexCut = { kind: "firstLine"; chars: number } | { kind: "lines"; cut: number; total: number; from: number; next?: string };

export interface ContextText {
	/** The warning after a MEMORY.md index loaded in part. */
	memoryIndexCut(p: { size: MemoryIndexSize; cut: MemoryIndexCut }): string;
	/** Opens the instructions block. */
	instructionsPreamble: string;
	/** One file's section, naming where it comes from; `content` ends in a newline. */
	section(p: { path: string; source: InstructionSource; content: string }): string;
	/** Opens the ONECODE.md block; `above` names the instruction files above it (CLAUDE.md, or AGENTS.md in independent mode). */
	oneCodePreamble(p: { above: string }): string;
	/** An instruction file attached when the model reads a file below the working directory. */
	nestedFile(p: { path: string; content: string }): string;
	/** Opens the context block. */
	contextPreamble: string;
	email(p: { email: string }): string;
	/** Closes the context block. */
	contextFooter: string;
	date(p: { date: string }): string;
	dateChanged(p: { date: string }): string;
	environment(env: EnvironmentFacts): string;
	/** `name` is the model's display name, `cutoff` its knowledge cutoff when known. */
	modelLine(p: { name: string; id: string; cutoff?: string }): string;
	/** The git snapshot; `at` says whether it was taken at the conversation's start or at its latest compaction. */
	gitStatus(p: { snapshot: GitSnapshot; at: "start" | "compaction" }): string;
	/** Closes a git status cut at `maxChars`; `shellTool` is the session's shell tool. */
	gitStatusClipped(p: { maxChars: number; shellTool: string }): string;
	/** The workspace changed since the context block was told. */
	changedSinceSnapshot(p: { changes: ContextChange[]; atCompaction: boolean }): string;
	/** In a skipped instruction file's slot; `imported` names the files inlined into it. */
	skippedInstruction(p: { tokens: number; contextWindow: number; imported: readonly string[] }): string;
	/** The auto-mode classifier's note for a skipped instruction file. */
	classifierSkippedInstruction(p: { tokens: number; contextWindow: number }): string;
}
