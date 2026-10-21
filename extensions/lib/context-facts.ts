/**
 * What claude-context's message-1 blocks tell, as ledger facts, and the notice
 * for a resumed session whose workspace changed since (pure). The blocks are
 * live state; an epoch records their fingerprints with its request, so the
 * first request of a resumed process compares them with the live files and git
 * status, and says what changed once. The historical blocks stay as sent.
 */
import { buildClaudeMdBlock, type ContextFile } from "./claude-context.ts";
import type { ToldFact } from "./ledger/records.ts";
import { contentHash } from "./ledger/wire.ts";
import { toldBlockFact } from "./reminders.ts";

/** The told keys of the fingerprints (whole-text block facts) and of the compaction flag (a mode). */
export const FACT_KEYS = {
	instructions: "context-facts:instructions",
	memory: "context-facts:memory",
	git: "context-facts:git",
	date: "context-facts:date",
	/** On when the epoch's blocks were taken at a compaction, not at the session's start. */
	compaction: "context-facts:compaction",
} as const;

/** A told block's hash (`toldBlockFact`): for a string or null it is the sha256 of its JSON. */
const fingerprint = contentHash;

/** Fingerprints of only what the model was shown, not unshown file tails or filesystem mtimes. */
export interface ContextFingerprints {
	instructions: string;
	memory: string;
}

export function contextFingerprints(input: { contextFiles: ContextFile[]; memoryIndex: { path: string; content: string } | null }): ContextFingerprints {
	return {
		instructions: fingerprint(buildClaudeMdBlock({ contextFiles: input.contextFiles })),
		memory: fingerprint(buildClaudeMdBlock({ contextFiles: [], memoryIndex: input.memoryIndex })),
	};
}

export const gitFingerprint = (gitStatus: string | null): string => fingerprint(gitStatus);

/** The live workspace's fingerprints for the resumed-session check: the instructions, the memory index and, when a git snapshot is taken, the git status. */
export type LiveFingerprints = ContextFingerprints & { git?: string };

export function liveFingerprints(files: Parameters<typeof contextFingerprints>[0], gitStatus: string | null, withGit: boolean): LiveFingerprints {
	return { ...contextFingerprints(files), ...(withGit ? { git: gitFingerprint(gitStatus) } : {}) };
}
export const dateFingerprint = (date: string): string => fingerprint(date);

/** The facts the instructions block tells. */
export function instructionFacts(prints: ContextFingerprints): ToldFact[] {
	return [
		{ kind: "block", key: FACT_KEYS.instructions, hash: prints.instructions },
		{ kind: "block", key: FACT_KEYS.memory, hash: prints.memory },
	];
}

/** The facts the context block tells: its git snapshot, and whether a compaction took it. */
export function contextBlockFacts(gitStatus: string | null, atCompaction: boolean): ToldFact[] {
	return [
		toldBlockFact(FACT_KEYS.git, gitStatus),
		{ kind: "mode", key: FACT_KEYS.compaction, on: atCompaction },
	];
}

/** A refreshed git snapshot must not describe itself as the conversation's initial status. */
export function compactionGitStatus(text: string | null): string | null {
	return text?.replace("This is the git status at the start of the conversation.", "This is the git status at the latest compaction.") ?? null;
}

/**
 * One short factual notice when the live workspace differs from what the
 * epoch's blocks told, and the facts that bring the told state up to date.
 * Undefined when nothing the epoch told has changed, or the epoch told none
 * of it (its blocks predate the facts).
 */
export function resumeFactsNotice(
	told: ReadonlyMap<string, string>,
	atCompaction: boolean,
	live: ContextFingerprints & { git?: string },
): { text: string; facts: ToldFact[] } | undefined {
	const changed: string[] = [];
	const facts: ToldFact[] = [];
	const compare = (key: string, hash: string | undefined, what: string) => {
		const before = told.get(key);
		if (hash === undefined || before === undefined || before === hash) return;
		changed.push(what);
		facts.push({ kind: "block", key, hash });
	};
	compare(FACT_KEYS.git, live.git, "git status changed");
	compare(FACT_KEYS.memory, live.memory, "the memory index changed");
	compare(FACT_KEYS.instructions, live.instructions, "CLAUDE.md-family instructions changed");
	if (changed.length === 0) return undefined;
	return {
		text: `Since the saved context snapshot, ${changed.join("; ")}. The earlier context block reflects ${atCompaction ? "the latest compaction" : "the session's start"}, not the current workspace. Read the current files or run git status if needed.`,
		facts,
	};
}
