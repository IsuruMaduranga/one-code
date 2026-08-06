/**
 * Auto mode's decision log (pure apart from the append).
 *
 * Opt-in via `autoMode.logDecisions: true`. One JSONL line per gate decision —
 * who decided (pre-gate, floor, classifier, the user at a prompt), what about,
 * and on what grounds — in `auto-mode-decisions.jsonl` next to the session
 * files, with a sessionId on each line.
 *
 * This exists because the calibration workflow is real: both regressions this
 * feature has had were caught by reading raw verdicts, and stderr under
 * CC_AUTO_MODE_DEBUG only helps when someone thought to set it *before* the
 * session. A standing log makes "what has the gate been deciding, and which
 * direction is drifting" answerable after the fact. The permissive direction
 * especially: allows are invisible in the UI by design, so this file is the
 * only complete record of them.
 *
 * Logging must never break the gate, so failures are swallowed: a gate that
 * blocks tool calls because its diary is unwritable has its priorities
 * backwards.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DecisionEntry {
	ts: string;
	sessionId?: string;
	tool: string;
	/** Command or path, clipped — never tool output. */
	subject: string;
	outcome: "allow" | "block" | "prompt";
	/** Which layer decided. */
	source: "pre-gate" | "classifier" | "floor" | "user" | "review";
	tier?: string;
	ruleId?: string;
	reason?: string;
	/** The classifier's own commentary, attributed (see prompt.ts). */
	raw?: string;
	/** `provider/id` of the model that produced a classifier verdict. */
	model?: string;
}

const SUBJECT_LIMIT = 300;

export function decisionEntry(entry: Omit<DecisionEntry, "ts" | "subject"> & { subject: string }): DecisionEntry {
	return {
		...entry,
		ts: new Date().toISOString(),
		subject: entry.subject.length > SUBJECT_LIMIT ? `${entry.subject.slice(0, SUBJECT_LIMIT)}…` : entry.subject,
	};
}

export function appendDecision(file: string, entry: DecisionEntry): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(entry)}\n`);
	} catch {
		// Logging must never break the gate.
	}
}
