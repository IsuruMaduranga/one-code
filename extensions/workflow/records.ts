/**
 * Per-agent run records (pure): folds the RunProgressEvent stream into
 * AgentRecord[] so the viewer can show each agent's prompt, model, activity,
 * and outcome. RunHandle owns one store and applies every recorded event;
 * timestamps are stamped here at apply time (host side — the vm's Date block
 * does not apply).
 */

import type { AgentRecord, RunProgressEvent } from "./types.ts";

/** The per-agent members of the event union (the ones records care about). */
type AgentEvent = Extract<RunProgressEvent, { callIndex: number }>;

function recordKey(callIndex: number, source?: string): string {
	return `${source ?? ""}#${callIndex}`;
}

export const ACTIVITY_CAP = 100;
export const PREVIEW_CAP = 2000;

/** Human-readable preview of an agent's returned value, hard-capped. */
export function previewValue(value: unknown, cap = PREVIEW_CAP, truncationMarker = "…"): string {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else if (value === undefined) {
		text = "(no value)";
	} else {
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			text = String(value);
		}
	}
	return text.length > cap ? `${text.slice(0, cap)}${truncationMarker}` : text;
}

export class AgentRecordStore {
	// Keyed by (source, callIndex): a nested workflow() child restarts its own
	// callIndex at 0, so callIndex alone would merge its agents into the parent's.
	private byKey = new Map<string, AgentRecord>();
	private order: string[] = [];

	constructor(private readonly now: () => number = () => Date.now()) {}

	/** Records in first-seen order (callIndex order for sequential scripts). */
	list(): AgentRecord[] {
		return this.order.map((key) => this.byKey.get(key) as AgentRecord);
	}

	get(callIndex: number, source?: string): AgentRecord | undefined {
		return this.byKey.get(recordKey(callIndex, source));
	}

	apply(event: RunProgressEvent): void {
		switch (event.type) {
			case "agentStart": {
				const record = this.ensure(event);
				record.status = "running";
				record.startedAt ??= this.now();
				record.prompt = event.prompt;
				break;
			}
			case "agentUpdate": {
				const record = this.ensure(event);
				if (event.model) record.model = event.model;
				if (event.tool) {
					record.activity.push(event.tool);
					if (record.activity.length > ACTIVITY_CAP) record.activity.shift();
				}
				break;
			}
			case "agentEnd": {
				const record = this.ensure(event);
				record.finishedAt = this.now();
				if (event.prompt !== undefined) record.prompt ??= event.prompt;
				if (event.tokens) record.tokens = event.tokens;
				if (event.cost !== undefined) record.cost = event.cost;
				if (event.preview !== undefined) record.outcome = event.preview;
				if (event.replayed) {
					record.status = "replayed";
				} else if (event.text) {
					record.status = "failed";
					record.error = event.text;
				} else {
					record.status = "done";
				}
				break;
			}
			default:
				break;
		}
	}

	private ensure(event: AgentEvent): AgentRecord {
		const key = recordKey(event.callIndex, event.source);
		const record = this.byKey.get(key);
		if (!record) {
			const created: AgentRecord = {
				callIndex: event.callIndex,
				source: event.source,
				label: event.label ?? `agent ${event.callIndex + 1}`,
				phase: event.phase,
				status: "running",
				activity: [],
			};
			this.byKey.set(key, created);
			this.order.push(key);
			return created;
		}
		// Later events may carry the label/phase a bare agentUpdate lacked.
		if (event.label) record.label = event.label;
		if (event.phase && !record.phase) record.phase = event.phase;
		return record;
	}
}
