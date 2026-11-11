/**
 * Which `/code-review` body a session gets (pure apart from reading the cell
 * files). The skill has no single body: it picks a "cell" by the model's
 * prompt tier and the effort level, from a table the profile's skill folder
 * ships beside the cells (`skills/code-review/cells/table.json`):
 *
 *   { "tables": { "default": { "low": "<cell>", … }, "frontier": { … } },
 *     "after": "<cell>" }
 *
 * `tables` maps an effort to a cell file (`<cell>.md`) per tier, `default`
 * for a tier without its own; `after`, when present, is a section every body
 * ends with. Which cells exist and why each tier takes its table is the
 * product's choice (One Code's: profile/skills/code-review/).
 *
 * The effort is the level the user typed first (`/code-review high 123`),
 * else the session's (`/effort`). Every cell runs in the session's own turn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptTier } from "../../lib/models/model-tier.ts";

export const REVIEW_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** The profile's table: per tier (or `default`), the cell of each effort; `after` follows every cell. */
export interface CellTable {
	tables: Readonly<Record<string, Readonly<Record<ReviewEffort, string>>>>;
	after?: string;
}

/** Reads and checks `<cellsDir>/table.json`; a table without a complete `default` fails loud, naming the file. */
export function readCellTable(cellsDir: string): CellTable {
	const path = join(cellsDir, "table.json");
	const table = JSON.parse(readFileSync(path, "utf-8")) as Partial<CellTable>;
	const problems: string[] = [];
	if (!table.tables?.default) problems.push('it has no "default" table');
	for (const [tier, cells] of Object.entries(table.tables ?? {})) {
		for (const effort of REVIEW_EFFORTS) if (typeof cells?.[effort] !== "string") problems.push(`table "${tier}" has no cell for "${effort}"`);
	}
	if (table.after !== undefined && typeof table.after !== "string") problems.push('"after" is not a cell name');
	if (problems.length > 0) throw new Error(`${path}: ${problems.join("; ")}.`);
	return table as CellTable;
}

export function codeReviewCell(table: CellTable, tier: PromptTier, effort: ReviewEffort): string {
	return (table.tables[tier] ?? table.tables.default)[effort];
}

/** The review effort for a session thinking level: below low reads as low, unknown as medium. */
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
 * The body for a session: the chosen cell, then the table's closing section. `args`
 * comes back without the typed level, which the cell already reflects.
 */
export function codeReviewBody(
	cellsDir: string,
	tier: PromptTier,
	thinkingLevel: string | undefined,
	args: string,
): { body: string; args: string; cell: string } {
	const { effort, rest } = parseCodeReviewArgs(args);
	const table = readCellTable(cellsDir);
	const cell = codeReviewCell(table, tier, effort ?? reviewEffortFor(thinkingLevel));
	// A checkout that turned line endings into CRLF still sends the same bytes.
	const read = (name: string) => readFileSync(join(cellsDir, `${name}.md`), "utf-8").replace(/\r\n/g, "\n").trimEnd();
	return { body: table.after ? `${read(cell)}\n\n${read(table.after)}` : read(cell), args: rest, cell };
}
