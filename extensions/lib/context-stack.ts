/** Session-file context snapshots and the bus contract. No stored value grants permissions. */
import type { ReminderEntry } from "./reminders.ts";

export const CONTEXT_STACK_ENTRY = "one-code:context-stack";
export const CONTEXT_STATE_ENTRY = "one-code:context-state";
export const CONTEXT_RESTORE_CHANNEL = "one-code:context-restore";
export const CONTEXT_BASELINE_CHANNEL = "one-code:context-baseline";
/** A completed compaction replaces the Claude context facts, including absent blocks. */
export const CONTEXT_FACTS_REFRESH_CHANNEL = "one-code:context-facts-refresh";

export interface ContextStackSnapshot {
	version: 1;
	stack: ReminderEntry[];
	sticky: ReminderEntry[];
	/** Delivered one-shots/breadcrumbs; absent in older snapshots. */
	pinned?: ReminderEntry[];
	/** Emitter-owned announcement baselines, not live configuration. */
	baselines: Record<string, unknown>;
}
export interface ContextRestoreRequest { restored?: ContextStackSnapshot }
export interface ContextBaseline { key: string; value: unknown }
export interface ContextFactsRefresh { entries: ReminderEntry[]; baseline: unknown }
interface Bus { emit(channel: string, data: unknown): void }

/** Synchronous request/reply: system-reminder restores before the emitters' session_start hooks. */
export function restoredContext(events: Bus): ContextStackSnapshot | undefined {
	const request: ContextRestoreRequest = {};
	events.emit(CONTEXT_RESTORE_CHANNEL, request);
	return request.restored;
}

/** Phase-1 capabilities must be re-emitted by their live owners, including removal. */
export const LIVE_CONTEXT_KEYS = new Set(["environment", "model-line", "one-shot", "skills"]);

/** Session facts and phase-2 emitters keep even an absent original block absent. */
export const RESTORED_STACK_KEYS = new Set([
	"claude-context", "one-code-context", "claude-context-context", "claude-context-date",
	"total-tokens-first", "auto-mode-note", "deferred-tools", "mcp-instructions", "mcp-failures",
	"subagent-models", "subagent-agents", "subagent-delegation",
]);

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function anchor(value: unknown): boolean {
	return record(value) && ((value.kind === "user" && typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) ||
		(value.kind === "toolResult" && typeof value.toolCallId === "string"));
}
function entries(value: unknown, placement: "first-prepend" | "sticky-append" | "pinned"): value is ReminderEntry[] {
	return Array.isArray(value) && value.every((e) => record(e) &&
		(placement === "pinned" ? e.placement === "last-append" || e.placement === "user-prepend" : e.placement === placement) && typeof e.text === "string" &&
		typeof e.order === "number" && Number.isFinite(e.order) &&
		(e.key === undefined || typeof e.key === "string") && (e.suffix === undefined || typeof e.suffix === "string") &&
		(e.toolCallId === undefined || placement === "sticky-append" && typeof e.toolCallId === "string") &&
		["raw", "systemRoleOnly", "skipStackCarrier"].every((key) => e[key] === undefined || typeof e[key] === "boolean") &&
		(e.since === undefined || typeof e.since === "number" && Number.isFinite(e.since)) &&
		(e.until === undefined || placement === "sticky-append" && typeof e.until === "number" && Number.isFinite(e.until)) &&
		(e.userPins === undefined || placement === "sticky-append" && Array.isArray(e.userPins) && e.userPins.every((stamp) => typeof stamp === "number" && Number.isFinite(stamp))) &&
		(e.opener === undefined || e.opener === null || typeof e.opener === "number" && Number.isFinite(e.opener)) &&
		(e.tailPin === undefined || anchor(e.tailPin)) && (placement === "pinned" ? anchor(e.pin) : e.pin === undefined));
}

/** Read only the selected branch. Malformed/unknown versions are ignored, never partly restored. */
export function contextStackOnBranch(branch: readonly { type: string; customType?: string; data?: unknown }[]): ContextStackSnapshot | undefined {
	let snapshot: ContextStackSnapshot | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom" || !record(entry.data) || entry.data.version !== 1) continue;
		const data = entry.data;
		if (data.pinned !== undefined && !entries(data.pinned, "pinned")) continue;
		if (entry.customType === CONTEXT_STACK_ENTRY && entries(data.stack, "first-prepend") && entries(data.sticky, "sticky-append") && record(data.baselines)) {
			snapshot = structuredClone(data) as unknown as ContextStackSnapshot;
		} else if (snapshot && entry.customType === CONTEXT_STATE_ENTRY && entries(data.sticky, "sticky-append") && record(data.baselines) &&
			(data.stack === undefined || entries(data.stack, "first-prepend"))) {
			if (data.stack !== undefined) snapshot.stack = structuredClone(data.stack) as ReminderEntry[];
			snapshot.sticky = structuredClone(data.sticky);
			if (data.pinned !== undefined) snapshot.pinned = structuredClone(data.pinned) as ReminderEntry[];
			snapshot.baselines = structuredClone(data.baselines);
		}
	}
	return snapshot;
}
