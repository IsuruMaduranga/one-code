/** Project the active session branch for the classifier; never keep a second transcript. */
import { inContextEntries, latestCompaction } from "../lib/compaction-boundary.ts";
import { isHistoricalRead, type TranscriptEntry } from "./transcript.ts";

/** Non-model-facing provenance for user messages and harness permission facts. */
export const CLASSIFIER_USER_INPUT = "auto-mode-user-input";
export const CLASSIFIER_TOOL_META = "auto-mode-tool-meta";

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n");
}

function record(value: unknown): Record<string, any> {
	return value !== null && typeof value === "object" ? value as Record<string, any> : {};
}

export function userMessageKey(timestamp: unknown, text: string): string {
	return JSON.stringify([timestamp, text]);
}

/** Where the projected history ends; neither field reads the whole active branch. */
export interface HistoryCursor {
	beforeToolCallId?: string;
	throughToolCallId?: string;
}

/**
 * Where a subagent's view of the main session ends, for its own gated calls
 * and its hand-back review. pi persists the main turn's whole tool-call batch
 * before any of it runs, so a later call in that batch is not yet context.
 * A child started by a call in the batch in flight (its Agent call, or the
 * SendMessage call that began this turn) sees through that call; one started
 * in an earlier turn sees every finished turn and none of the batch in
 * flight; with nothing in flight it sees the whole branch. A child whose
 * starting call is unknown (a workflow agent, a cron fire) keeps the last
 * main call as its cursor.
 */
export function childHistoryCursor(startedBy: string | undefined, inFlight: readonly string[], lastMainCall: string | undefined): HistoryCursor {
	if (startedBy === undefined) return { throughToolCallId: lastMainCall };
	if (inFlight.includes(startedBy)) return { throughToolCallId: startedBy };
	return inFlight.length > 0 ? { beforeToolCallId: inFlight[0] } : {};
}

/**
 * The summary comes before the kept tail, though its stored entry follows it.
 * `beforeToolCallId` excludes the pending call and later calls from the same
 * assistant message (pi persists the whole tool-call batch before executing it).
 * A bridged child uses `throughToolCallId` to include its parent's running call.
 */
export function classifierHistory(branch: readonly unknown[], options: HistoryCursor = {}): {
	transcript: TranscriptEntry[];
	userMessages: string[];
} {
	const transcript: TranscriptEntry[] = [];
	const userMessages: string[] = [];
	const boundary = latestCompaction(branch);
	if (boundary) {
		const summary = record(branch[boundary.index]).summary;
		if (typeof summary === "string" && summary) transcript.push({ kind: "summary", text: summary });
	}
	const provenance = new Map<string, string | null>();
	for (const raw of branch) {
		const entry = record(raw);
		if (entry.type !== "custom" || entry.customType !== CLASSIFIER_USER_INPUT) continue;
		const data = record(entry.data);
		if (typeof data.messageText === "string" && (typeof data.userText === "string" || data.userText === null)) {
			provenance.set(userMessageKey(data.timestamp, data.messageText), data.userText);
		}
	}
	const active = inContextEntries(branch).map(record);
	const facts = new Map<string, Record<string, any>[]>();
	for (const entry of active) {
		if (entry.type !== "custom" || entry.customType !== CLASSIFIER_TOOL_META) continue;
		const data = record(entry.data);
		if (typeof data.toolCallId !== "string") continue;
		const list = facts.get(data.toolCallId) ?? [];
		list.push(data);
		facts.set(data.toolCallId, list);
	}
	let reachedPending = false;
	for (const entry of active) {
		if (reachedPending) break;
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			transcript.push({ kind: "summary", text: entry.summary });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = record(entry.message);
		if (message.role === "user") {
			const text = messageText(message.content);
			const key = userMessageKey(message.timestamp, text);
			// Old sessions have only user-role messages. New sessions preserve the
			// input event's source, so extension-generated turns never gain intent
			// authority on resume and expanded skill text is not credited as typed.
			const userText = provenance.has(key) ? provenance.get(key) : text;
			if (userText?.trim()) {
				transcript.push({ kind: "user", text: userText.trim() });
				userMessages.push(userText.trim());
			}
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const rawBlock of message.content) {
				const block = record(rawBlock);
				if (block.type !== "toolCall" || typeof block.name !== "string") continue;
				if (options.beforeToolCallId !== undefined && block.id === options.beforeToolCallId) {
					reachedPending = true;
					break;
				}
				const tool: TranscriptEntry = { kind: "tool", tool: block.name, input: record(block.arguments) };
				if (!isHistoricalRead(tool)) {
					for (const fact of facts.get(block.id) ?? []) if (fact.gitStatus) transcript.push({ kind: "meta", gitStatus: fact.gitStatus });
					transcript.push(tool);
				}
				// A standing permission-rule denial is relevant even when the local
				// read input itself is omitted from ordinary history.
				for (const fact of facts.get(block.id) ?? []) {
					if (typeof fact.deniedSubject === "string" && typeof fact.rule === "string") {
						transcript.push({ kind: "denied", tool: block.name, subject: fact.deniedSubject, rule: fact.rule });
					}
				}
				if (options.throughToolCallId !== undefined && block.id === options.throughToolCallId) {
					reachedPending = true;
					break;
				}
			}
		}
	}
	return { transcript, userMessages };
}
