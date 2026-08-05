/**
 * Run journal (pure). Every completed agent() call is appended to
 * journal.jsonl as `{callIndex, hash, result, timestamp}`; on resume the
 * longest prefix of calls whose positional index AND hash still match replays
 * from the journal at zero cost, and the first mismatch switches the run to
 * live mode for good (Claude Code's longest-unchanged-prefix rule).
 *
 * The hash covers exactly the inputs that change what an agent would do
 * (prompt, model, effort, schema, agentType, isolation) and deliberately
 * excludes cosmetic options (label, phase) so renaming a progress group does
 * not invalidate a replay.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AgentCallOptions, AgentCallResult, JournalEntry } from "./types.ts";

export function hashAgentCall(prompt: string, opts: AgentCallOptions): string {
	const canonical = JSON.stringify({
		prompt,
		model: opts.model ?? null,
		effort: opts.effort ?? null,
		schema: opts.schema ?? null,
		agentType: opts.agentType ?? null,
		isolation: opts.isolation ?? null,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

export function readJournal(path: string): JournalEntry[] {
	if (!existsSync(path)) return [];
	const entries: JournalEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as JournalEntry;
			if (typeof entry.callIndex === "number" && typeof entry.hash === "string" && entry.result) {
				entries.push(entry);
			}
		} catch {
			// A torn final line (killed mid-write) is expected; ignore it.
		}
	}
	entries.sort((a, b) => a.callIndex - b.callIndex);
	return entries;
}

export function appendJournal(path: string, entry: JournalEntry): void {
	appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Replay cursor over a prior run's journal. `match()` consumes entries in
 * positional order; the first miss (index gap, hash change, or exhausted
 * journal) permanently switches to live mode.
 */
export class ReplayCursor {
	private byIndex: Map<number, JournalEntry>;
	private live = false;

	constructor(entries: JournalEntry[]) {
		this.byIndex = new Map(entries.map((e) => [e.callIndex, e]));
	}

	/** Journaled result for this call, or undefined once the prefix is broken. */
	match(callIndex: number, hash: string): AgentCallResult | undefined {
		if (this.live) return undefined;
		const entry = this.byIndex.get(callIndex);
		if (!entry || entry.hash !== hash) {
			this.live = true;
			return undefined;
		}
		return entry.result;
	}

	/** Totals across all journaled entries, for seeding budget/agent counters. */
	static totals(entries: JournalEntry[]): { agentCount: number; outputTokens: number; cost: number } {
		let outputTokens = 0;
		let cost = 0;
		for (const entry of entries) {
			outputTokens += entry.result.tokens?.output ?? 0;
			cost += entry.result.cost ?? 0;
		}
		return { agentCount: entries.length, outputTokens, cost };
	}
}
