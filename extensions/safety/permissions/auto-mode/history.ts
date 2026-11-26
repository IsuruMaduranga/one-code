/** Project the active session branch for the classifier; never keep a second transcript. */
import { createHash } from "node:crypto";
import { inContextEntries, latestCompaction } from "../../../lib/request/compaction-boundary.ts";
import { isHistoricalRead, toolCallEntry, type TranscriptEntry } from "./transcript.ts";

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

/**
 * A pending call's arguments as the model wrote them: its toolCall block on
 * the branch (the latest with that id, since some providers repeat ids). The
 * gate shows the call this way because the history will show it this way on
 * the next call, so the classifier's transcript only grows and its cache
 * holds. The tool_call hook's own input has been through the tool's argument
 * preparation (the Agent tool adds `task` beside a model's `prompt`).
 */
export function writtenArguments(branch: readonly unknown[], toolCallId: string): unknown {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = record(branch[i]);
		const message = record(entry.message);
		if (entry.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const block = message.content.map(record).find((candidate) => candidate.type === "toolCall" && candidate.id === toolCallId);
		if (block) return block.arguments;
	}
	return undefined;
}

/**
 * A user message's identity in the provenance entries: its timestamp and a
 * digest of its text. Provenance only has to recognise the message, so the
 * text itself is not stored a second time.
 */
export function userMessageDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function userMessageKey(timestamp: unknown, digest: string): string {
	return JSON.stringify([timestamp, digest]);
}

/**
 * What provenance records of one user-role message: the words the user typed
 * (null for an extension-generated turn), and whether they submitted them
 * while the agent was still working.
 */
interface UserInput {
	text: string | null;
	queued: boolean;
}

/** What a branch's provenance entries say, and how far into the branch that was read. */
interface ProvenanceIndex {
	head?: string;
	length: number;
	tail?: unknown;
	/** Whether the branch has any provenance entry: none means a session from before provenance. */
	recorded: boolean;
	byKey: Map<string, UserInput>;
	/** Entry id → digest of that user message's text. */
	digests: Map<string, string>;
}

let provenanceMemo: ProvenanceIndex | undefined;

/**
 * The provenance entries of a branch. pi only appends, so a gated call
 * resumes the scan where the previous one stopped; a branch whose prefix
 * changed (a new session, a /tree switch past the read point) is read again.
 * Entries without ids are never memoised.
 */
function provenanceIndex(branch: readonly unknown[]): ProvenanceIndex {
	const id = (i: number): unknown => record(branch[i]).id;
	const head = id(0);
	const memo = provenanceMemo;
	const resumable = typeof head === "string" && memo !== undefined && memo.head === head && memo.length <= branch.length && (memo.length === 0 || id(memo.length - 1) === memo.tail);
	const index: ProvenanceIndex = resumable ? memo : { head: typeof head === "string" ? head : undefined, length: 0, recorded: false, byKey: new Map(), digests: new Map() };
	for (let i = index.length; i < branch.length; i++) {
		const entry = record(branch[i]);
		if (entry.type !== "custom" || entry.customType !== CLASSIFIER_USER_INPUT) continue;
		index.recorded = true;
		const data = record(entry.data);
		if (typeof data.userText !== "string" && data.userText !== null) continue;
		// Entries written before the digest carry the message text itself.
		const digest = typeof data.messageDigest === "string" ? data.messageDigest : typeof data.messageText === "string" ? userMessageDigest(data.messageText) : undefined;
		if (digest !== undefined) index.byKey.set(userMessageKey(data.timestamp, digest), { text: data.userText, queued: data.queued === true });
	}
	index.length = branch.length;
	index.tail = id(branch.length - 1);
	provenanceMemo = typeof head === "string" && typeof index.tail === "string" ? index : undefined;
	return index;
}

/**
 * The words a user-role message gives the classifier as the user's own: the
 * input event's text when recorded, null for an extension-generated turn.
 * Every user message gets an entry once the gate is loaded, so a message
 * without one was written before it (plain pi, or a build before provenance)
 * and is unverified (undefined), even after the resumed session records new ones.
 */
function userInput(index: ProvenanceIndex, entry: Record<string, any>, message: Record<string, any>, text: string): UserInput | undefined {
	if (!index.recorded) return undefined;
	let digest = typeof entry.id === "string" ? index.digests.get(entry.id) : undefined;
	if (digest === undefined) {
		digest = userMessageDigest(text);
		if (typeof entry.id === "string") index.digests.set(entry.id, digest);
	}
	return index.byKey.get(userMessageKey(message.timestamp, digest));
}

/** Where the projected history ends; neither field reads the whole active branch. */
export interface HistoryCursor {
	beforeToolCallId?: string;
	throughToolCallId?: string;
}

/**
 * The question dialog's tool, and what opens the user line that carries its
 * answer. A tool result is otherwise never shown to the classifier; this one
 * is the harness's own report of what the user chose in the dialog, so it is
 * the user's word on the question asked. Claude Code sends the same line.
 */
const QUESTION_TOOL = "ask_user_question";
export const QUESTION_ANSWER_PREFIX = "[User answered AskUserQuestion]:   ";

/**
 * The sentence the question tool wrote for answers the user submitted, read
 * from the result's details (the tool's own record, which neither the model
 * nor a hook that rewrites the result's content can write). The tool records
 * it only for a submitted answer: a dialog the user cancelled or turned into
 * a chat lists unsubmitted selections or the model's own questions.
 */
function submittedAnswer(details: unknown): string | undefined {
	const { answerText } = record(details);
	return typeof answerText === "string" && answerText.trim() ? answerText : undefined;
}

/**
 * The most of an agent message a transcript carries as the referent for the
 * user's reply: its last characters, where the proposal or the question is.
 * Claude Code keeps the last 2,000; a plan the user approves with a short
 * reply is often longer than that (two in three of the messages measured,
 * the longest about 6,400 characters), and a plan cut off above the step it
 * proposes cannot be affirmed.
 */
export const PRIOR_PROSE_CHARS = 8000;

/**
 * An assistant message's prose as the user saw it: its text blocks (thinking
 * and tool calls left out), nothing for an errored reply or one that is only
 * whitespace, clipped to its last PRIOR_PROSE_CHARS without splitting a
 * surrogate pair.
 */
function shownProse(message: Record<string, any>): string | undefined {
	if (message.stopReason === "error") return undefined;
	const text = messageText(message.content);
	if (!text.trim()) return undefined;
	if (text.length <= PRIOR_PROSE_CHARS) return text;
	const tail = text.slice(-PRIOR_PROSE_CHARS);
	const first = tail.charCodeAt(0);
	return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
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
 *
 * The agent's last prose before each typed user message goes directly above
 * it: a reply such as "go ahead" names nothing, and the ruleset reads it
 * against that proposal. Tool calls between the two keep it; any other
 * user-role message drops it, since the reply may answer that message, and so
 * does a reply the user submitted while the agent was still working. The
 * entry is appended with the reply, so the transcript still only grows, and
 * every caller projects it, so a child's view stays a prefix of what the main
 * session's calls sent.
 *
 * The question dialog's answer is the one tool result projected: a user line
 * at the result's own place on the branch (after every call of that batch, so
 * a later call's transcript extends an earlier one's), matched to its call by
 * id, taken from the tool's own record of a submitted answer and left out
 * when the tool errored (no dialog was shown) or the user cancelled the
 * dialog or chose to chat instead.
 */
export function classifierHistory(branch: readonly unknown[], options: HistoryCursor = {}): TranscriptEntry[] {
	const transcript: TranscriptEntry[] = [];
	const boundary = latestCompaction(branch);
	if (boundary) {
		const summary = record(branch[boundary.index]).summary;
		if (typeof summary === "string" && summary) transcript.push({ kind: "summary", text: summary });
	}
	const provenance = provenanceIndex(branch);
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
	let prose: string | undefined;
	const questionCalls = new Set<string>();
	for (const entry of active) {
		if (reachedPending) break;
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			transcript.push({ kind: "summary", text: entry.summary });
			prose = undefined;
			continue;
		}
		// A notification or another extension message reaches the model as a
		// user-role message: the user's next reply may answer it.
		if (entry.type === "custom_message") prose = undefined;
		if (entry.type !== "message") continue;
		const message = record(entry.message);
		if (message.role === "user") {
			// Sessions preserve the input event's source, so extension-generated
			// turns never gain intent authority on resume and expanded skill text
			// is not credited as typed.
			const input = userInput(provenance, entry, message, messageText(message.content));
			const userText = input?.text?.trim();
			if (userText) {
				// A message submitted while the agent was working was written before
				// the agent's latest message existed, so it is not a reply to it.
				if (prose !== undefined && !input?.queued) transcript.push({ kind: "assistant", text: prose });
				transcript.push({ kind: "user", text: userText });
			}
			prose = undefined;
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			prose = shownProse(message) ?? prose;
			for (const rawBlock of message.content) {
				const block = record(rawBlock);
				if (block.type !== "toolCall" || typeof block.name !== "string") continue;
				if (options.beforeToolCallId !== undefined && block.id === options.beforeToolCallId) {
					reachedPending = true;
					break;
				}
				if (block.name === QUESTION_TOOL && typeof block.id === "string") questionCalls.add(block.id);
				const tool = toolCallEntry(block.name, block.arguments);
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
		} else if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string" || !questionCalls.has(message.toolCallId) || message.isError === true) continue;
			const answer = submittedAnswer(message.details);
			if (answer === undefined) continue;
			transcript.push({ kind: "user", text: `${QUESTION_ANSWER_PREFIX}${answer}` });
			// The answer is a user turn: a later reply may answer what followed it, not the prose before it.
			prose = undefined;
		} else {
			// A `!` command's output and the like: user-role text of its own.
			prose = undefined;
		}
	}
	return transcript;
}
