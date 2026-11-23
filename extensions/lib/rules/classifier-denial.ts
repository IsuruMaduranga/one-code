/**
 * The first sentence of auto mode's denial (pure, no words in force), shared
 * by the text the model reads (permission-text.ts) and the transcript, which
 * draws Claude Code's one dim line for it (lib/ui/tui-render.ts rejectionLine).
 */

export const CLASSIFIER_DENIED = "Permission for this action was denied by the auto-mode approval classifier.";

/** Whether a tool result is auto mode's denial. */
export function isClassifierDenial(text: string): boolean {
	return text.startsWith(CLASSIFIER_DENIED);
}
