/**
 * The ledger's session entries: what One Code records on the branch so every
 * request is a pure function of it (working-docs/features/lifecycle-grid-hunt/design.md
 * section 4). Each is a pi custom entry (`pi.appendEntry`), invisible to the
 * model and to plain pi, carrying `v` (the record format) and `by` (the One
 * Code version that wrote it). A record of any other `v` is ignored, never
 * partly read: that part of the branch is rendered again once and recorded
 * anew (design.md section 13 and the plan's record versioning).
 *
 * Pure: no pi imports.
 */

export const LEDGER_VERSION = 1;

export const RECORD = {
	/** One request as sent, as a delta against the previous one on the branch. */
	request: "one-code:request",
	/** What each injected block announced (tool names, skills, a mode switch, a delivered pending item). */
	told: "one-code:told",
	/** Durable session state, latest entry per key wins. */
	state: "one-code:state",
	/** Produced for the model, not yet sent. */
	pending: "one-code:pending",
	/**
	 * An epoch opens at the next request: written right before the record of a
	 * request that opened one, and by an owner that must change the history
	 * above the append point (the no-op loop fold) to make the next one open.
	 */
	epoch: "one-code:epoch",
	/** Written at every `/tree`: pi keeps the leaf move only in memory. */
	branch: "one-code:branch",
} as const;

export type RecordKind = keyof typeof RECORD;

/** The fields every record carries. */
export interface RecordBase {
	v: typeof LEDGER_VERSION;
	by: string;
}

/** Who a request went to; a change opens an epoch. */
export interface RequestIdentity {
	api: string;
	provider: string;
	model: string;
	/** "key" | "oauth" | "chatgpt": OAuth renames tools, ChatGPT sign-in drops fields, so a change opens an epoch. */
	auth: string;
	/** Whether pi-ai puts its per-message effort markers in the list; absent on a model without them. */
	effortMarkers?: boolean;
}

export const sameIdentity = (a: RequestIdentity, b: RequestIdentity): boolean =>
	a.api === b.api && a.provider === b.provider && a.model === b.model && a.auth === b.auth && a.effortMarkers === b.effortMarkers;

/**
 * Which of the session's context messages a request covers: the first `count`
 * of pi's `context` messages, the last of them identified by role and
 * timestamp. The next request in the epoch sends only the messages after them
 * (the tail) through pi, and takes the rest from the record.
 */
export interface Coverage {
	count: number;
	role: string;
	timestamp: number;
}

export interface RequestRecordData extends RecordBase {
	identity: RequestIdentity;
	/** Absent on a record that cannot be extended (written without a context pass): the next request opens an epoch. */
	covers?: Coverage;
	/** Elements of the previous request's list reused unchanged. */
	keep: number;
	/** Content hashes of the elements appended after them. */
	append: string[];
	/** Content hash of the non-list body (system, tools, thinking, …). */
	head: string;
	/** Bodies for hashes not yet on the branch, by hash. */
	blobs: Record<string, unknown>;
	/** Pending ids this request carried, so the outbox drops them. */
	consumed: string[];
	/**
	 * The session whose cache host the request was routed to (pi-ai's
	 * session-affinity headers): the session that opened the epoch, so a /fork
	 * that extends its parent's request goes where the parent's cache lives.
	 */
	routing?: string;
}

export type ToldFact =
	/**
	 * `callable`: announced by a `tool_addition` the model may call at once, not
	 * only listed for tool_search. `removed`: announced gone, so the epoch no
	 * longer holds them told.
	 */
	| { kind: "tools"; names: string[]; callable?: boolean; removed?: boolean }
	| { kind: "skills"; names: string[] }
	| { kind: "mode"; key: string; on: boolean }
	/** A whole-text block (a menu, a catalog): the content hash of the text last told under `key`. */
	| { kind: "block"; key: string; hash: string };

/** A whole-text block fact. */
export type BlockFact = Extract<ToldFact, { kind: "block" }>;

export interface ToldRecordData extends RecordBase {
	facts: ToldFact[];
}

export interface StateRecordData extends RecordBase {
	key: string;
	value: unknown;
}

export interface PendingRecordData extends RecordBase {
	id: string;
	/** A later pending item with the same key replaces this one while both are undelivered. */
	key?: string;
	text: string;
	/** Where it lands: the request's tail (default), or before the text of the prompt that opens a request. */
	placement?: "last-append" | "user-prepend";
	/** Sent bare instead of inside a `<system-reminder>` frame. */
	raw?: boolean;
	/** Rides this call's result when the request carries it. */
	toolCallId?: string;
	/** `user-prepend` only: placed once per request, however many are pending (the shared caveat). */
	once?: boolean;
	/** `user-prepend` only: on a request that does not open with a prompt, it rides the tail instead of waiting for one. */
	orTail?: boolean;
	/** Dropped, undelivered, at a later compaction: it belongs to the epoch the compaction before it opened (a post-compaction restore). */
	untilCompaction?: boolean;
	/**
	 * Files whose whole content the item shows the model (a post-compaction
	 * restore), as they were when it was produced. The item and this record
	 * are one entry, so file-tracker's replay counts the files read exactly
	 * where the branch holds the item.
	 */
	observations?: FileVersion[];
	/** The changed versions of files the item names without showing them (a changed-on-disk notice): never a read. */
	notified?: FileVersion[];
}

/** A file's version as a pending item or a tool result records it: the absolute path and content hash, with the size and modification time when known. */
export interface FileVersion {
	/** Absolute, as the tool resolved it (worktree included). */
	path: string;
	sha256: string;
	size?: number;
	mtimeMs?: number;
}

const EPOCH_CAUSES = ["first", "compaction", "model", "auth", "effort", "fold", "coverage", "empty"] as const;

/** Why an epoch opened: no request yet, a compaction, a model or auth switch, thinking turned off or on where pi marks effort per message, a history fold, a base that cannot be extended, or nothing new since it. */
export type EpochCause = (typeof EPOCH_CAUSES)[number];

export interface EpochRecordData extends RecordBase {
	cause: EpochCause;
}

export interface BranchRecordData extends RecordBase {
	fromLeafId: string;
}

export interface RecordData {
	request: RequestRecordData;
	told: ToldRecordData;
	state: StateRecordData;
	pending: PendingRecordData;
	epoch: EpochRecordData;
	branch: BranchRecordData;
}

/** The slice of a pi session entry the ledger reads. */
export interface EntryLike {
	type: string;
	id: string;
	parentId?: string | null;
	customType?: string;
	data?: unknown;
	message?: { role?: string; stopReason?: string };
	/** A `context_edit`: the entry it edits, and its replacement (null omits the entry from the model's view). */
	targetId?: string;
	replacement?: unknown;
}

export type ParsedRecord = { [K in RecordKind]: { kind: K; entryId: string; data: RecordData[K] } }[RecordKind];

const KIND_BY_TYPE = new Map<string, RecordKind>(Object.entries(RECORD).map(([kind, type]) => [type, kind as RecordKind]));

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

export const isFileVersion = (file: unknown): file is FileVersion =>
	isObject(file) && isString(file.path) && isString(file.sha256) && (file.size === undefined || typeof file.size === "number") && (file.mtimeMs === undefined || typeof file.mtimeMs === "number");
const isFileVersions = (value: unknown): boolean => Array.isArray(value) && value.every(isFileVersion);

const isCoverage = (value: unknown): boolean =>
	isObject(value) && Number.isInteger(value.count) && (value.count as number) >= 0 && isString(value.role) && typeof value.timestamp === "number";

function isToldFact(fact: unknown): boolean {
	if (!isObject(fact)) return false;
	switch (fact.kind) {
		case "tools":
			return isStrings(fact.names) && (fact.callable === undefined || typeof fact.callable === "boolean") && (fact.removed === undefined || typeof fact.removed === "boolean");
		case "skills":
			return isStrings(fact.names);
		case "mode":
			return isString(fact.key) && typeof fact.on === "boolean";
		case "block":
			return isString(fact.key) && isString(fact.hash);
		default:
			return false;
	}
}

/** Each kind's own fields, checked whole: a record that fails is ignored, never partly read. */
const SHAPE: { [K in RecordKind]: (data: Record<string, unknown>) => boolean } = {
	request: (d) =>
		(d.covers === undefined || isCoverage(d.covers)) &&
		isObject(d.identity) &&
		isString(d.identity.api) &&
		isString(d.identity.provider) &&
		isString(d.identity.model) &&
		isString(d.identity.auth) &&
		(d.identity.effortMarkers === undefined || typeof d.identity.effortMarkers === "boolean") &&
		Number.isInteger(d.keep) &&
		(d.keep as number) >= 0 &&
		isStrings(d.append) &&
		isString(d.head) &&
		isObject(d.blobs) &&
		isStrings(d.consumed) &&
		(d.routing === undefined || isString(d.routing)),
	told: (d) => Array.isArray(d.facts) && d.facts.every(isToldFact),
	state: (d) => isString(d.key) && "value" in d,
	pending: (d) =>
		isString(d.id) &&
		isString(d.text) &&
		(d.key === undefined || isString(d.key)) &&
		(d.placement === undefined || d.placement === "last-append" || d.placement === "user-prepend") &&
		(d.raw === undefined || typeof d.raw === "boolean") &&
		(d.toolCallId === undefined || isString(d.toolCallId)) &&
		(d.once === undefined || typeof d.once === "boolean") &&
		(d.orTail === undefined || typeof d.orTail === "boolean") &&
		(d.untilCompaction === undefined || typeof d.untilCompaction === "boolean") &&
		(d.observations === undefined || isFileVersions(d.observations)) &&
		(d.notified === undefined || isFileVersions(d.notified)),
	epoch: (d) => (EPOCH_CAUSES as readonly unknown[]).includes(d.cause),
	branch: (d) => isString(d.fromLeafId),
};

/** The entry as a ledger record, or undefined when it is not one, has another `v`, or is malformed. */
export function readRecord(entry: EntryLike): ParsedRecord | undefined {
	if (entry.type !== "custom" || entry.customType === undefined) return undefined;
	const kind = KIND_BY_TYPE.get(entry.customType);
	const data = entry.data;
	if (!kind || !isObject(data) || data.v !== LEDGER_VERSION || !isString(data.by) || !SHAPE[kind](data)) return undefined;
	return { kind, entryId: entry.id, data } as unknown as ParsedRecord;
}

/** A record's data with `v` and `by` filled in, ready for `pi.appendEntry(RECORD[kind], …)`. */
export function makeRecord<K extends RecordKind>(_kind: K, by: string, fields: Omit<RecordData[K], keyof RecordBase>): RecordData[K] {
	return { v: LEDGER_VERSION, by, ...fields } as RecordData[K];
}

/** The latest value the branch's `one-code:state` entries hold for `key`, or undefined when none does (latest wins). */
export function stateOnBranch(branch: readonly EntryLike[], key: string): unknown {
	for (let i = branch.length - 1; i >= 0; i--) {
		const record = readRecord(branch[i]);
		if (record?.kind === "state" && record.data.key === key) return record.data.value;
	}
	return undefined;
}
