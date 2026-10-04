/**
 * Which `/code-review` body a session gets (pure apart from reading the cell
 * files). Claude Code no longer has one body: it picks a "cell" by the model
 * and the effort level, from one table per model family. One Code keys the
 * same choice by prompt tier:
 *
 * - frontier takes Claude Code's default table, the one its Opus 5.5,
 *   Sonnet 5.5 and Fable sessions use (minimal prompt at medium, inline
 *   angles at high and xhigh, a verified fan-out at max);
 * - workhorse, cheap and tiny take its Sonnet 5 table: the long, explicit
 *   recipe (finder angles fanned out over the Agent tool, a verify vote)
 *   written for the one model below that line Claude Code tunes a table for.
 *   Claude Code's default table reaches its older models only because they
 *   have no table of their own; its medium cell leaves the whole review to
 *   the model's judgment, which the lower tiers' registers exist to avoid.
 *
 * The effort is the level the user typed first (`/code-review high 123`),
 * else the session's (`/effort`). Claude Code runs Opus 5.5's medium cell as
 * a background fork; here every cell runs in the session's own turn.
 *
 * The cells are Claude Code's text in `skills/code-review/cells/`; the minimal
 * prompt reports through the JSON array the other cells use, since One Code
 * has no findings tool. Every cell is followed by One Code's "Arguments and
 * flags" section.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptTier } from "../lib/model-tier.ts";

export const REVIEW_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** Claude Code's default table (`cells/<name>.md`). */
const DEFAULT_TABLE: Record<ReviewEffort, string> = {
	low: "low-1-pass-max4",
	medium: "minimal-prompt",
	high: "high-8-inline",
	xhigh: "xhigh-10-inline-sweep",
	max: "max-5x5-verify-sweep",
};

/** Claude Code's Sonnet 5 table. */
const SONNET5_TABLE: Record<ReviewEffort, string> = {
	low: "low-1-pass-min-files-4",
	medium: "medium-3x5-verify",
	high: "high-3x5-recall-verify",
	xhigh: "xhigh-5x5-verify-sweep",
	max: "max-5x5-verify-sweep",
};

export const ARGUMENTS_AND_FLAGS = "arguments-and-flags";

export function codeReviewCell(tier: PromptTier, effort: ReviewEffort): string {
	return (tier === "frontier" ? DEFAULT_TABLE : SONNET5_TABLE)[effort];
}

/** The review effort for a session thinking level: below low reads as low, unknown as medium (Claude Code's default). */
export function reviewEffortFor(thinkingLevel: string | undefined): ReviewEffort {
	switch (thinkingLevel) {
		case "off":
		case "minimal":
		case "low":
			return "low";
		case "high":
		case "xhigh":
		case "max":
			return thinkingLevel;
		default:
			return "medium";
	}
}

/** A typed level as the first argument (`/code-review high 123`) and what follows it. */
export function parseCodeReviewArgs(args: string): { effort?: ReviewEffort; rest: string } {
	const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(args);
	const first = match?.[1]?.toLowerCase();
	if (!first || !(REVIEW_EFFORTS as readonly string[]).includes(first)) return { rest: args.trim() };
	return { effort: first as ReviewEffort, rest: (match?.[2] ?? "").trim() };
}

/**
 * The body for a session: the chosen cell, then the flags section. `args`
 * comes back without the typed level, which the cell already reflects.
 */
export function codeReviewBody(
	cellsDir: string,
	tier: PromptTier,
	thinkingLevel: string | undefined,
	args: string,
): { body: string; args: string; cell: string } {
	const { effort, rest } = parseCodeReviewArgs(args);
	const cell = codeReviewCell(tier, effort ?? reviewEffortFor(thinkingLevel));
	// A checkout that turned line endings into CRLF still sends Claude Code's bytes.
	const read = (name: string) => readFileSync(join(cellsDir, `${name}.md`), "utf-8").replace(/\r\n/g, "\n").trimEnd();
	return { body: `${read(cell)}\n\n${read(ARGUMENTS_AND_FLAGS)}`, args: rest, cell };
}
