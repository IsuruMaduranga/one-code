/**
 * Claude Code's environment block and model line (pure): the first two parts of
 * its mid-conversation system message, and the first two blocks of the first
 * user message on a model without one (lib/request/system-role.ts). They left the
 * system prompt, which keeps only what never varies per session.
 */

import { contextWords } from "./context-words.ts";

import { parseClaudeId } from "../models/model-tier.ts";

export interface EnvironmentFacts {
	cwd: string;
	isGitRepo: boolean;
	platform: string;
	shell: string;
	osVersion: string;
	/** The session's private scratchpad, when one could be made (lib/core/scratchpad.ts). */
	scratchpadDir?: string;
	/** The workspace directories as the session started; listed only when there are some. */
	workspaceDirs?: string[];
}

/** The `# Environment` block, in the profile's words. */
export function environmentBlock(env: EnvironmentFacts): string {
	return contextWords().environment(env);
}

/** Knowledge cutoffs Claude Code states, keyed by family and version. */
const CLAUDE_CUTOFFS: Record<string, string> = {
	"opus 4.5": "May 2025",
	"opus 4.6": "May 2025",
	"opus 4.7": "January 2026",
	"opus 4.8": "January 2026",
	"opus 5": "May 2026",
	"opus 5.5": "June 2026",
	"sonnet 4.5": "January 2025",
	"sonnet 4.6": "August 2025",
	"sonnet 5": "January 2026",
	"sonnet 5.5": "June 2026",
	"haiku 4.5": "February 2025",
	"haiku 5.5": "June 2026",
	"fable 5.1": "June 2026",
};

/** A Claude model's name as Claude Code says it ("Opus 5.5", "Haiku 4.5"), from an id in any provider's spelling. */
export function claudeDisplayName(id: string): string | undefined {
	const claude = parseClaudeId(id);
	if (!claude) return undefined;
	const family = claude.family[0].toUpperCase() + claude.family.slice(1);
	return claude.minor === undefined ? `${family} ${claude.major}` : `${family} ${claude.major}.${claude.minor}`;
}

/**
 * Claude Code's model sentence. A Claude model gets its name and, where
 * Claude Code states one, its knowledge cutoff; any other model gets the
 * catalog's name and no cutoff clause, since the cutoff is a per-model fact.
 */
export function modelLine(model: { id: string; name?: string }): string {
	const claude = claudeDisplayName(model.id);
	const name = claude ?? (model.name || model.id);
	const cutoff = claude ? CLAUDE_CUTOFFS[claude.toLowerCase()] : undefined;
	return contextWords().modelLine({ name, id: model.id, ...(cutoff ? { cutoff } : {}) });
}
