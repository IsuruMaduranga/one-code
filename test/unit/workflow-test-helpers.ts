import {
	createRunAdmission,
	createScriptGlobals,
	type RunAdmissionOptions,
	type ScriptGlobalsOptions,
} from "../../extensions/workflow/globals.ts";
import type { AgentCallFn, JournalEntry, RunProgressEvent } from "../../extensions/workflow/types.ts";

export type GlobalsOverrides = Partial<ScriptGlobalsOptions> & Partial<RunAdmissionOptions>;

/**
 * Script globals over a fake agent runner, with the run's events and journal
 * captured. Admission fields (`budgetTotal`, `concurrency`, `maxAgents`) build a
 * fresh admission unless `admission` is passed (a nested-workflow child).
 */
export function makeGlobals({ budgetTotal = null, concurrency = 4, maxAgents, ...overrides }: GlobalsOverrides = {}) {
	const events: RunProgressEvent[] = [];
	const journal: JournalEntry[] = [];
	const agentCall: AgentCallFn = async (prompt) => ({
		value: `done: ${prompt}`,
		tokens: { input: 10, output: 50, total: 60 },
		cost: 0.01,
	});
	const options: ScriptGlobalsOptions = {
		agentCall,
		args: undefined,
		admission: createRunAdmission({ budgetTotal, concurrency, maxAgents }),
		signal: new AbortController().signal,
		onEvent: (e) => events.push(e),
		onJournal: (e) => journal.push(e),
		now: () => 1700000000000,
		...overrides,
	};
	return { ...createScriptGlobals(options), events, journal };
}
