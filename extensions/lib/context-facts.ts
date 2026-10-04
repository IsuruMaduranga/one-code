/** Comparisons for the historical context stack. No pi imports or live-state reads. */
import { createHash } from "node:crypto";
import { buildClaudeMdBlock, buildContextBlock, type ContextFile } from "./claude-context.ts";
import type { ReminderEntry } from "./reminders.ts";

export const CONTEXT_FACT_KEYS = ["claude-context", "one-code-context", "claude-context-context", "claude-context-date"] as const;
export const RESUME_FACTS_KEY = "context-resume-changes";
export const DATE_CHANGE_KEY = "claude-context-date-change";

export interface ContextFactsBaseline {
	instructions: string;
	memory: string;
	git: string;
	/** A compaction starts a new snapshot epoch, not a new conversation. */
	atCompaction: boolean;
}

const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Hash only what the model was shown, not unshown file tails or filesystem mtimes. */
export function contextFactsBaseline(input: {
	contextFiles: ContextFile[];
	memoryIndex: { path: string; content: string } | null;
	gitStatus: string | null;
	atCompaction: boolean;
}): ContextFactsBaseline {
	return {
		instructions: fingerprint(buildClaudeMdBlock({ contextFiles: input.contextFiles })),
		memory: fingerprint(buildClaudeMdBlock({ contextFiles: [], memoryIndex: input.memoryIndex })),
		git: fingerprint(input.gitStatus),
		atCompaction: input.atCompaction,
	};
}

export function storedFactsBaseline(value: unknown): ContextFactsBaseline | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (![v.instructions, v.memory, v.git].every((part) => typeof part === "string" && /^[a-f0-9]{64}$/.test(part)) || typeof v.atCompaction !== "boolean") return undefined;
	return v as unknown as ContextFactsBaseline;
}

/** A refreshed git snapshot must not describe itself as the conversation's initial status. */
export function compactionGitStatus(text: string | null): string | null {
	return text?.replace("This is the git status at the start of the conversation.", "This is the git status at the latest compaction.") ?? null;
}

/** One short factual notice; the historical blocks themselves remain byte-identical. */
export function resumeFactsNotice(before: ContextFactsBaseline, current: ContextFactsBaseline): string | undefined {
	const changed: string[] = [];
	if (before.git !== current.git) changed.push("git status changed");
	if (before.memory !== current.memory) changed.push("the memory index changed");
	if (before.instructions !== current.instructions) changed.push("CLAUDE.md-family instructions changed");
	if (changed.length === 0) return undefined;
	return `Since the saved context snapshot, ${changed.join("; ")}. The earlier context block reflects ${before.atCompaction ? "the latest compaction" : "the session's start"}, not the current workspace. Read the current files or run git status if needed.`;
}

/** Old snapshots lack separate fingerprints: do not invent which half of # claudeMd changed. */
export function legacyResumeFactsNotice(stack: readonly ReminderEntry[], live: {
	instructions: string | null;
	email: string | null;
	gitStatus: string | null;
}): string | undefined {
	const changed: string[] = [];
	const previousContext = stack.find((entry) => entry.key === "claude-context-context")?.text ?? null;
	const gitPart = (text: string | null) => text?.match(/# gitStatus\n[\s\S]*?(?=\n\nOne Code attached this context automatically;|$)/)?.[0] ?? null;
	if (gitPart(previousContext) !== gitPart(buildContextBlock(live))) changed.push("git status changed");
	if ((stack.find((entry) => entry.key === "claude-context")?.text ?? null) !== live.instructions) changed.push("CLAUDE.md-family instructions or the memory index changed");
	return changed.length ? `Since the saved context snapshot, ${changed.join("; ")}. The earlier context block reflects the session's start, not the current workspace. Read the current files or run git status if needed.` : undefined;
}
