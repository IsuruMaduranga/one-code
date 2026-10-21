/**
 * The fold: everything the ledger knows, derived from the current branch's
 * entries alone (design.md sections 3 to 5). Resume, `/reload`, `/fork` and
 * `/tree` need no restore code because each folds a different branch.
 *
 * Rules: told facts are a union within the
 * epoch and start empty at its start; pending items are those no request
 * delivered; pi's `usage` entries (a cache warm) are skipped. An epoch starts
 * at the first request, after a compaction entry or an `epoch` record, and at
 * a request whose identity (api, provider, model, auth) differs.
 *
 * Delivered means the model saw it and the branch kept it. A request counts
 * (its consumed pending ids and the told records written with it, and it
 * becomes the base the next request extends) only when its own reply follows
 * it: the first message after the request record, before any other request,
 * epoch or compaction, is an assistant message that did not end in an error
 * or an abort and that pi did not omit later (a `context_edit` with no
 * replacement: a recoverable length stop, a failed attempt before a retry).
 * A request with no reply (the turn in flight, a process that died
 * mid-stream, a re-send that replaced it, a btw fork copied mid-stream)
 * counts nothing, so its pending items are delivered again.
 * A request that does not count takes back what it changed: the `epoch`
 * record written right before it and an identity change it made, so a failed
 * model hop leaves the epoch it left.
 *
 * The rebuilt request shares its elements with the branch's entries: clone
 * before mutating (`spliceRequest` does).
 *
 * Pure: no pi imports.
 */
import { type Coverage, type EntryLike, type EpochCause, type PendingRecordData, readRecord, type RequestIdentity, type RequestRecordData, sameIdentity, type ToldFact } from "./records.ts";
import { declaredToolNames, type RecordedRequest } from "./wire.ts";

export type { EpochCause };

/** A recorded request as the fold rebuilds it: the wire list and head, the context messages it covered, and where it was routed. */
export interface FoldedRequest extends RecordedRequest {
	covers?: Coverage;
	routing?: string;
}

export interface LedgerFold {
	/** True when the next request opens an epoch: no request yet, a compaction or `epoch` record since, or a changed identity. */
	opensEpoch: boolean;
	/** Why, when `opensEpoch`. */
	cause?: EpochCause;
	/** The last request on the branch that counts (its reply followed it and stayed), rebuilt from its records. */
	lastRequest: FoldedRequest | undefined;
	/** Every element hash already stored on the branch. */
	knownHashes: Set<string>;
	/** Every tool the branch's counted requests declared, in the order of its first declaration: the order an epoch renders (ledger/wire.ts). */
	toolOrder: string[];
	/** Told facts in the current epoch: kind ("tools", "skills", `CALLABLE_TOOLS`) to names. */
	told: Map<string, Set<string>>;
	/** Modes told in the current epoch, by key: on or off as last told. */
	modes: Map<string, boolean>;
	/** Whole-text blocks told in the current epoch, by key: the content hash of the text last told. */
	blocks: Map<string, string>;
	/** Produced and not yet sent, latest per key, in branch order. */
	pending: PendingRecordData[];
}

/** The told kind of the tools announced by a callable `tool_addition` (also folded under "tools"). */
export const CALLABLE_TOOLS = "tools:callable";

/** What an epoch has told the model, as the fold keeps it and a render reads it. */
export interface ToldState {
	told: Map<string, Set<string>>;
	modes: Map<string, boolean>;
	blocks: Map<string, string>;
}

/** Add `facts` to what the epoch told: a mode or block as last told, names as a union (callable tools also under `CALLABLE_TOOLS`), tools told gone taken out. */
export function tellFacts(into: ToldState, facts: readonly ToldFact[]): void {
	for (const fact of facts) {
		if (fact.kind === "mode") into.modes.set(fact.key, fact.on);
		else if (fact.kind === "block") into.blocks.set(fact.key, fact.hash);
		else if (fact.kind === "tools" && fact.removed) {
			for (const kind of ["tools", CALLABLE_TOOLS]) for (const name of fact.names) into.told.get(kind)?.delete(name);
		} else {
			const kinds = fact.kind === "tools" && fact.callable ? ["tools", CALLABLE_TOOLS] : [fact.kind];
			for (const kind of kinds) {
				const set = into.told.get(kind) ?? new Set<string>();
				for (const name of fact.names) set.add(name);
				into.told.set(kind, set);
			}
		}
	}
}

/** What `facts` tell an epoch that starts empty. */
export function toldOf(facts: readonly ToldFact[]): ToldState {
	const state: ToldState = { told: new Map(), modes: new Map(), blocks: new Map() };
	tellFacts(state, facts);
	return state;
}

/** The request a record describes, rebuilt on its base; undefined when the branch lacks a body it needs. */
function rebuild(data: RequestRecordData, base: RecordedRequest | undefined, blobs: ReadonlyMap<string, unknown>): FoldedRequest | undefined {
	const kept = base?.list.length ?? 0;
	if (data.keep > kept || !blobs.has(data.head) || !data.append.every((hash) => blobs.has(hash))) return undefined;
	const head = blobs.get(data.head);
	if (typeof head !== "object" || head === null || Array.isArray(head)) return undefined;
	return {
		identity: data.identity,
		list: [...(base?.list.slice(0, data.keep) ?? []), ...data.append.map((hash) => blobs.get(hash))],
		head: head as Record<string, unknown>,
		hashes: [...(base?.hashes.slice(0, data.keep) ?? []), ...data.append],
		headHash: data.head,
		...(data.covers ? { covers: data.covers } : {}),
		...(data.routing ? { routing: data.routing } : {}),
	};
}

/**
 * What a request that does not count takes back: the told state, the epoch
 * cause and the identity from before it. The told state is held by reference,
 * not copied: nothing tells into it while a checkpoint is live (an epoch or a
 * changed identity replaces it, and told records riding a request wait in its
 * `facts` until it counts, when its checkpoint is dropped).
 */
interface FoldCheckpoint {
	told: ToldState;
	resetSinceBase: EpochCause | undefined;
	lastIdentity: RequestIdentity | undefined;
}

/** The ids of the entries pi omitted from the model's view: a `context_edit` with no replacement. */
function omittedIds(branch: readonly EntryLike[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of branch) if (entry.type === "context_edit" && entry.replacement === null && typeof entry.targetId === "string") ids.add(entry.targetId);
	return ids;
}

/** Fold the branch (root first, as `getBranch()` returns it). `identity` is the live request identity, for epoch detection. */
export function foldBranch(branch: readonly EntryLike[], identity?: RequestIdentity): LedgerFold {
	const blobs = new Map<string, unknown>();
	let told = toldOf([]);
	const produced: { item: PendingRecordData; index: number }[] = [];
	const consumed = new Set<string>();
	const omitted = omittedIds(branch);
	/** The index of the last compaction on the branch: an older `untilCompaction` pending item is stale. */
	let lastCompaction = -1;
	let base: FoldedRequest | undefined;
	const toolOrder = new Set<string>();
	/** The head hash of the last counted request, whose declarations `toolOrder` holds. */
	let orderedHead: string | undefined;
	/** A compaction or `epoch` record after the base: the next request renders everything again. */
	let resetSinceBase: EpochCause | undefined;
	let lastIdentity: RequestIdentity | undefined;
	/** The state before the last `epoch` record, while nothing but its own request may follow it. */
	let beforeEpoch: { index: number; checkpoint: FoldCheckpoint } | undefined;
	/** The latest request and what rode it, until its reply settles it. */
	let open: { request: FoldedRequest | undefined; consumed: string[]; facts: ToldFact[]; checkpoint: FoldCheckpoint } | undefined;

	const tell = (facts: readonly ToldFact[]) => tellFacts(told, facts);
	const checkpoint = (): FoldCheckpoint => ({ told, resetSinceBase, lastIdentity });
	/** A new epoch starts with nothing told: a new state, so a checkpoint keeps the one it holds. */
	const resetTold = () => {
		told = toldOf([]);
	};
	/** Count what the open request carried and make it the base; a request without its reply takes back what it changed. */
	const settle = (counts: boolean) => {
		if (!open) return;
		if (counts) {
			for (const id of open.consumed) consumed.add(id);
			tell(open.facts);
			if (open.request) {
				base = open.request;
				resetSinceBase = undefined;
				// Requests mostly share their head: the last counted one's adds no name.
				if (open.request.headHash !== orderedHead) for (const name of declaredToolNames(open.request.head)) toolOrder.add(name);
				orderedHead = open.request.headHash;
			}
		} else {
			({ told, resetSinceBase, lastIdentity } = open.checkpoint);
		}
		open = undefined;
	};

	branch.forEach((entry, index) => {
		const attached = beforeEpoch?.index === index - 1 ? beforeEpoch : undefined;
		beforeEpoch = undefined;
		if (entry.type === "message") {
			// A request's reply is the first message after its record: pi stores the
			// prompt before the request and the tool results after the reply, so a
			// user message first (a btw fork's side question, copied mid-stream) means
			// no reply. pi drops an errored or aborted reply from the next request
			// (transform-messages.js) and omits a recovered one.
			const message = entry.message;
			settle(message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && !omitted.has(entry.id));
			return;
		}
		if (entry.type === "compaction") {
			lastCompaction = index;
			settle(false);
			resetTold();
			resetSinceBase = "compaction";
			return;
		}
		const record = readRecord(entry);
		if (!record) return;
		switch (record.kind) {
			case "epoch":
				settle(false);
				beforeEpoch = { index, checkpoint: checkpoint() };
				resetTold();
				resetSinceBase = record.data.cause;
				return;
			case "request": {
				settle(false);
				const data = record.data;
				for (const [hash, body] of Object.entries(data.blobs)) if (!blobs.has(hash)) blobs.set(hash, body);
				const before = attached?.checkpoint ?? checkpoint();
				if (lastIdentity && !sameIdentity(lastIdentity, data.identity)) resetTold();
				lastIdentity = data.identity;
				open = { request: rebuild(data, base, blobs), consumed: data.consumed, facts: [], checkpoint: before };
				return;
			}
			case "told":
				if (open) open.facts.push(...record.data.facts);
				else tell(record.data.facts);
				return;
			case "pending":
				produced.push({ item: record.data, index });
				return;
		}
	});
	settle(false);

	const latestByKey = new Map<string, number>();
	for (const { item, index } of produced) if (item.key !== undefined) latestByKey.set(item.key, index);
	const pending = produced
		.filter(({ item, index }) => item.key === undefined || latestByKey.get(item.key) === index)
		.filter(({ item, index }) => !consumed.has(item.id) && !(item.untilCompaction && index < lastCompaction))
		.map(({ item }) => item);

	const changed = (b: RequestIdentity, live: RequestIdentity): EpochCause | undefined =>
		b.model !== live.model || b.api !== live.api || b.provider !== live.provider
			? "model"
			: b.auth !== live.auth
				? "auth"
				: b.effortMarkers !== live.effortMarkers
					? "effort"
					: undefined;
	// A compaction with no settled request before it (the only request failed, a
	// session recorded before the ledger) still opens the compaction's epoch.
	const cause: EpochCause | undefined = resetSinceBase ?? (!base ? "first" : identity ? changed(base.identity, identity) : undefined);
	return {
		opensEpoch: cause !== undefined,
		...(cause ? { cause } : {}),
		lastRequest: base,
		knownHashes: new Set(blobs.keys()),
		toolOrder: [...toolOrder],
		...told,
		pending,
	};
}
