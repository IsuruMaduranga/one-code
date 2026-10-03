/**
 * Claude Code's environment block and model line (pure): the first two parts of
 * its mid-conversation system message, and the first two blocks of the first
 * user message on a model without one (lib/system-role.ts). They left the
 * system prompt, which keeps only what never varies per session.
 */

export interface EnvironmentFacts {
	cwd: string;
	isGitRepo: boolean;
	platform: string;
	shell: string;
	osVersion: string;
	/** The session's private scratchpad, when one could be made (lib/scratchpad.ts). */
	scratchpadDir?: string;
	/** The workspace directories as the session started; listed only when there are some. */
	workspaceDirs?: string[];
}

/** Claude Code's `# Environment` block, byte for byte; the trailing space after "environment:" is Claude Code's. */
export function environmentBlock(env: EnvironmentFacts): string {
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
	"fable 5.1": "June 2026",
};

/**
 * A Claude model's name as Claude Code says it ("Opus 5.5", "Haiku 4.5"),
 * from an id in any provider's spelling: `claude-opus-5-5`,
 * `claude-haiku-4-5-20251001`, `anthropic/claude-opus-5.5`. Undefined for
 * anything else; a dated suffix is never read as the minor version.
 */
export function claudeDisplayName(id: string): string | undefined {
	const match = id.match(/(?:^|[/.])claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?(?=$|[-@:[])/);
	if (!match) return undefined;
	const family = match[1][0].toUpperCase() + match[1].slice(1);
	return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
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
	const base = `You are powered by the model named ${name}. The exact model ID is ${model.id}.`;
	return cutoff ? `${base} Assistant knowledge cutoff is ${cutoff}.` : base;
}
