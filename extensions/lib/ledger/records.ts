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
	/** Opens an epoch: the head is rendered again. */
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
	/** "api-key" | "oauth" | …: OAuth renames tools, so a change opens an epoch. */
	auth: string;
}

export interface RequestRecordData extends RecordBase {
	identity: RequestIdentity;
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
}

export type ToldFact =
	| { kind: "tools"; names: string[] }
	| { kind: "skills"; names: string[] }
	| { kind: "agents"; names: string[] }
	| { kind: "mcp"; server: string; hash: string }
	| { kind: "mode"; key: string; on: boolean };

export interface ToldRecordData extends RecordBase {
	facts: ToldFact[];
}

export interface StateRecordData extends RecordBase {
	key: string;
	value: unknown;
}

export interface PendingRecordData extends RecordBase {
	id: string;
	source: string;
	key?: string;
	text: string;
}

export interface EpochRecordData extends RecordBase {
	cause: "first" | "compaction" | "model" | "auth" | "fold";
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
}

export type ParsedRecord = { [K in RecordKind]: { kind: K; entryId: string; data: RecordData[K] } }[RecordKind];

const KIND_BY_TYPE = new Map<string, RecordKind>(Object.entries(RECORD).map(([kind, type]) => [type, kind as RecordKind]));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

const EPOCH_CAUSES: ReadonlySet<string> = new Set(["first", "compaction", "model", "auth", "fold"]);

function isToldFact(fact: unknown): boolean {
	if (!isObject(fact)) return false;
	switch (fact.kind) {
		case "tools":
		case "skills":
		case "agents":
			return isStrings(fact.names);
		case "mcp":
			return isString(fact.server) && isString(fact.hash);
		case "mode":
			return isString(fact.key) && typeof fact.on === "boolean";
		default:
			return false;
	}
}

/** Each kind's own fields, checked whole: a record that fails is ignored, never partly read. */
const SHAPE: { [K in RecordKind]: (data: Record<string, unknown>) => boolean } = {
	request: (d) =>
		isObject(d.identity) &&
		isString(d.identity.api) &&
		isString(d.identity.provider) &&
		isString(d.identity.model) &&
		isString(d.identity.auth) &&
		Number.isInteger(d.keep) &&
		(d.keep as number) >= 0 &&
		isStrings(d.append) &&
		isString(d.head) &&
		isObject(d.blobs) &&
		isStrings(d.consumed),
	told: (d) => Array.isArray(d.facts) && d.facts.every(isToldFact),
	state: (d) => isString(d.key) && "value" in d,
	pending: (d) => isString(d.id) && isString(d.source) && isString(d.text) && (d.key === undefined || isString(d.key)),
	epoch: (d) => isString(d.cause) && EPOCH_CAUSES.has(d.cause),
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
