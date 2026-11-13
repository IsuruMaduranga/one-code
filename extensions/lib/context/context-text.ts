/**
 * The words of the first-message context, the way Claude Code words them:
 * the instructions block, the context block (email, git status), the date
 * lines, the environment block and model line, and the notes about
 * instruction files left out for size. The section headers (`# userEmail`,
 * `# gitStatus`, `# Environment`) are part of the words; the harness that
 * attached the context is named through the brand. The profile supplies what
 * names its own instruction file and another product's (`ContextText`).
 */

import { brand } from "../profile/brand.mjs";
import type { LiveTools } from "../profile/live-tools.ts";
import type { EnvironmentFacts } from "./environment-block.ts";
import type { GitSnapshot } from "./git-status.ts";

/** Where an instruction file comes from; the key a section's descriptor is worded by. */
export type InstructionSource = "global" | "managed" | "project" | "local" | "memory" | "product" | "productGlobal" | "agents" | "agentsGlobal";

/** What changed in the workspace since the context block was told. */
export type ContextChange = "git" | "memory" | "instructions" | "product";

/** How far a MEMORY.md index is over its limits (sizes already formatted). */
export type MemoryIndexSize =
	| { kind: "chars"; size: string; limit: string }
	| { kind: "lines"; lines: number; limit: number }
	| { kind: "both"; lines: number; size: string };

/** What of a MEMORY.md index was not loaded; `next` is the first line cut, shortened. */
export type MemoryIndexCut = { kind: "firstLine"; chars: number } | { kind: "lines"; cut: number; total: number; from: number; next?: string };

/** The profile's part of the words. */
export interface ContextText {
	/** Above the product's own instruction file (`brand.productFile`), when a session loads one; `above` is the name of the file family above it. */
	productPreamble(p: { above: string }): string;
	/** A section's descriptor for the product's own instruction file, in a project and in the user's state folder. */
	descriptors: { product: string; productGlobal: string };
}

/** The words, as `contextText` builds them. */
export type ContextWords = ReturnType<typeof contextText>;

const DESCRIPTORS: Record<Exclude<InstructionSource, "product" | "productGlobal">, string> = {
	global: "user's private global instructions for all projects",
	managed: "organization-managed policy instructions",
	project: "project instructions, checked into the codebase",
	local: "user's private project instructions, not checked in",
	memory: "user's auto-memory, persists across conversations",
	agents: "cross-tool agent instructions, AGENTS.md standard",
	agentsGlobal: "user's private global cross-tool agent instructions for all projects, AGENTS.md standard",
};

const CHANGES: Record<Exclude<ContextChange, "instructions">, string> = {
	git: "git status changed",
	memory: "the memory index changed",
	product: `${brand.productFile} instructions changed`,
};

const MEMORY_SIZE = (size: MemoryIndexSize): string =>
	size.kind === "chars"
		? `${size.size} (limit: ${size.limit}) — index entries are too long`
		: size.kind === "lines"
			? `${size.lines} lines (limit: ${size.limit})`
			: `${size.lines} lines and ${size.size}`;

const MEMORY_CUT = (cut: MemoryIndexCut): string =>
	cut.kind === "firstLine"
		? `everything after the first ${cut.chars} characters of line 1 was cut off`
		: `${cut.cut} of ${cut.total} lines were cut off, starting at line ${cut.from}${cut.next ? ` ("${cut.next}")` : ""}`;

/** When the git snapshot says it was taken; a refreshed snapshot swaps one phrase for the other (instructions/context-facts.ts). */
export const GIT_STATUS_TAKEN_AT = { start: "the start of the conversation", compaction: "the latest compaction" } as const;

/** The words, with the profile's part. */
export const contextText = (_live: LiveTools, product: ContextText) => ({
	/** The warning after a MEMORY.md index loaded in part. */
	memoryIndexCut: ({ size, cut }: { size: MemoryIndexSize; cut: MemoryIndexCut }): string =>
		`> WARNING: MEMORY.md is ${MEMORY_SIZE(size)}. Only part of it was loaded: ${MEMORY_CUT(cut)}. Keep index entries to one line under ~200 chars; move detail into topic files.`,
	/** Opens the instructions block. */
	instructionsPreamble:
		"Codebase and user instructions are shown below. Be sure to adhere to these instructions. " +
		"IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
	/** One file's section, naming where it comes from; `content` ends in a newline. */
	section: ({ path, source, content }: { path: string; source: InstructionSource; content: string }): string =>
		`Contents of ${path} (${source === "product" ? product.descriptors.product : source === "productGlobal" ? product.descriptors.productGlobal : DESCRIPTORS[source]}):\n\n${content}`,
	/** Opens the ONECODE.md block; `above` names the instruction files above it (CLAUDE.md, or AGENTS.md in independent mode). */
	productPreamble: (p: { above: string }): string => product.productPreamble(p),
	/** An instruction file attached when the model reads a file below the working directory. */
	nestedFile: ({ path, content }: { path: string; content: string }): string => `Contents of ${path}:\n\n${content}`,
	/** Opens the context block. */
	contextPreamble: "As you answer the user's questions, you can use the following context:",
	// Claude Code's sentence after the email.
	email: ({ email }: { email: string }): string =>
		`# userEmail\nThe user's email address is ${email}. ` +
		"Use it only to identify the user, such as for authorship, attribution, or filtering their own work. " +
		"Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.",
	/** Closes the context block. */
	contextFooter:
		`${brand.name} attached this context automatically; it isn't part of the user's message. ` +
		"It describes the user's own account and workspace, so they don't need it reported back.",
	date: ({ date }: { date: string }): string => `Today's date is ${date}.`,
	dateChanged: ({ date }: { date: string }): string => `The date has changed. Today's date is now ${date}. No need to announce the new date — the user's own clock shows it.`,
	environment: (env: EnvironmentFacts): string => {
		const lines = [
			"# Environment",
			"You have been invoked in the following environment: ",
			` - Primary working directory: ${env.cwd}`,
			` - Is a git repository: ${env.isGitRepo}`,
		];
		if (env.workspaceDirs?.length) lines.push(" - Additional working directories:", ...env.workspaceDirs.map((dir) => `  - ${dir}`));
		lines.push(` - Platform: ${env.platform}`, ` - Shell: ${env.shell}`, ` - OS Version: ${env.osVersion}`);
		if (env.scratchpadDir) {
			lines.push(
				` - Scratchpad directory: ${env.scratchpadDir} — always use it for temporary files (intermediate results, scripts, outputs that don't belong in the project) instead of \`/tmp\` or other system temp directories; it is session-specific, isolated from the project, and can generally be used without permission prompts. Only use \`/tmp\` if the user explicitly asks.`,
			);
		}
		return lines.join("\n");
	},
	/** `name` is the model's display name, `cutoff` its knowledge cutoff when known. */
	modelLine: ({ name, id, cutoff }: { name: string; id: string; cutoff?: string }): string => {
		const base = `You are powered by the model named ${name}. The exact model ID is ${id}.`;
		return cutoff ? `${base} Assistant knowledge cutoff is ${cutoff}.` : base;
	},
	/** The git snapshot; `at` says whether it was taken at the conversation's start or at its latest compaction. */
	gitStatus: ({ snapshot: s, at }: { snapshot: GitSnapshot; at: "start" | "compaction" }): string =>
		[
			`# gitStatus\nThis is the git status at ${GIT_STATUS_TAKEN_AT[at]}. ` +
				"Note that this status is a snapshot in time, and will not update during the conversation.",
			"",
			`Current branch: ${s.branch}`,
			"",
			`Main branch (you will usually use this for PRs): ${s.mainBranch}`,
			"",
			...(s.user ? [`Git user: ${s.user}`, ""] : []),
			"Status:",
			s.status || "(clean)",
			"",
			"Recent commits:",
			s.commits,
		].join("\n"),
	/** Closes a git status cut at `maxChars`; `shellTool` is the session's shell tool. */
	gitStatusClipped: ({ shellTool }: { maxChars: number; shellTool: string }): string => `\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${shellTool})`,
	/** The workspace changed since the context block was told; `file` is the project instruction file's name (`instructionTargets().project`). */
	changedSinceSnapshot: ({ changes, atCompaction, file }: { changes: ContextChange[]; atCompaction: boolean; file: string }): string =>
		`Since the saved context snapshot, ${changes.map((change) => (change === "instructions" ? `${file}-family instructions changed` : CHANGES[change])).join("; ")}. The earlier context block reflects ${atCompaction ? "the latest compaction" : "the session's start"}, not the current workspace. Read the current files or run git status if needed.`,
	/** In a skipped instruction file's slot; `imported` names the files inlined into it. */
	skippedInstruction: ({ tokens, contextWindow, imported }: { tokens: number; contextWindow: number; imported: readonly string[] }): string => {
		const what = imported.length > 0 ? `This file and the files it imports (${imported.join(", ")}) are not loaded: together they are` : "This file is not loaded: it is";
		return (
			`${what} about ${tokens.toLocaleString("en-US")} tokens, and instruction files may take at most half of this model's ` +
			`${contextWindow.toLocaleString("en-US")}-token context window. Read the parts of it that bear on your task when you need them.\n`
		);
	},
	/** The auto-mode classifier's note for a skipped instruction file. */
	classifierSkippedInstruction: ({ tokens, contextWindow }: { tokens: number; contextWindow: number }): string =>
		`(Not shown: this instruction file is about ${tokens.toLocaleString("en-US")} tokens, and instruction files may take at most half of the session model's ` +
		`${contextWindow.toLocaleString("en-US")}-token context window, so it is left out here as it is for the agent. Leaving it out grants no permission.)`,
});
