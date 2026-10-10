/** Successful PreCompact hook output, scoped to the compaction that requested it. */
export const PRECOMPACT_INSTRUCTIONS_CHANNEL = "one-code:precompact-instructions";

export interface PreCompactInstructions {
	signal: AbortSignal;
	instructions: string;
}
