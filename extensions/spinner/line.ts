/**
 * Pure pieces of the Claude Code working line ("✳ Hyperspacing… (10s · ↓ 448
 * tokens)") — formats matched to a frame capture of CC 2.1.233 plus its
 * reconstructed Spinner source.
 */

import { formatDuration } from "../lib/tui-render.ts";
import { formatTokenCount } from "../subagents/usage.ts";

/**
 * CC's spinner glyph frames (Spinner/utils.ts), mirrored forward-then-back.
 * Ghostty gets `*` for ✽ (renders offset there); non-mac gets `*` for ✳.
 */
export function spinnerFrames(platform: string, term: string | undefined): string[] {
	const chars =
		term === "xterm-ghostty"
			? ["·", "✢", "✳", "✶", "✻", "*"]
			: platform === "darwin"
				? ["·", "✢", "✳", "✶", "✻", "✽"]
				: ["·", "✢", "*", "✶", "✻", "✽"];
	return [...chars, ...[...chars].reverse()];
}

/** CC estimates streamed tokens as response characters / 4. */
export function estimateTokens(responseChars: number): number {
	return Math.round(responseChars / 4);
}

/**
 * `Verb… (elapsed · ↓ N tokens)` — the token part appears once anything has
 * streamed, formatted compactly the way CC's formatNumber does (448, 1.3k).
 */
export function composeWorkingMessage(input: { verb: string; elapsedMs: number; responseChars: number }): string {
	const parts = [formatDuration(0, input.elapsedMs)];
	const tokens = estimateTokens(input.responseChars);
	if (tokens > 0) parts.push(`↓ ${formatTokenCount(tokens)} tokens`);
	return `${input.verb}… (${parts.join(" · ")})`;
}

/** Character count of an assistant message's streamed text + thinking blocks. */
export function messageChars(message: unknown): number {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		const b = block as { type?: string; text?: string; thinking?: string };
		if (typeof b?.text === "string") total += b.text.length;
		if (typeof b?.thinking === "string") total += b.thinking.length;
	}
	return total;
}
