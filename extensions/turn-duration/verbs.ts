/**
 * Claude Code's turn-completion verbs, verbatim from the reconstructed source
 * (src/constants/turnCompletionVerbs.ts) — the past-tense verb shown after a
 * response finishes ("✻ Cooked for 5m 12s"). One is picked at random per turn.
 * These read naturally with "for <duration>", so the gerund spinner list
 * (spinner/verbs.ts) is deliberately not reused.
 */

export const TURN_COMPLETION_VERBS: readonly string[] = [
	"Baked",
	"Brewed",
	"Churned",
	"Cogitated",
	"Cooked",
	"Crunched",
	"Sautéed",
	"Worked",
];

/** Random completion verb for one turn; `random` is injectable for tests. */
export function pickCompletionVerb(random: () => number = Math.random): string {
	const index = Math.min(TURN_COMPLETION_VERBS.length - 1, Math.floor(random() * TURN_COMPLETION_VERBS.length));
	return TURN_COMPLETION_VERBS[index];
}
