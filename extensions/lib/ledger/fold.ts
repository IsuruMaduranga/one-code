/**
 * The fold: everything the ledger knows, derived from the current branch's
 * entries alone (design.md sections 3 to 5). Resume, `/reload`, `/fork` and
 * `/tree` need no restore code because each folds a different branch.
 *
 * Rules: told facts are a union within the
 * epoch and start empty at its start; pending items are those no request
 * consumed; the last request is the last one whose reply did not fail (pi
 * omits a failed reply before the next request); pi's `usage` entries (a
 * cache warm) are skipped. An epoch starts at the first request, after a
 * compaction entry or an `epoch` record, and at a request whose identity (api,
 * provider, model, auth) differs.
 *
 * A request's consumed pending ids and the told records written after it
 * count unless its reply failed: a failed request's tail is rendered again,
 * so what it carried is neither delivered nor told. A request with no reply
 * yet counts and is the base (the turn in flight, or a quit mid-stream).
 *
 * The rebuilt request shares its elements with the branch's entries: clone
 * before mutating (`spliceRequest` does).
 *
 * Pure: no pi imports.
 */
import { type Coverage, type EntryLike, type EpochCause, type PendingRecordData, readRecord, type RequestIdentity, type RequestRecordData, sameIdentity, type ToldFact } from "./records.ts";
import type { RecordedRequest } from "./wire.ts";

export type { EpochCause };

/** A recorded request as the fold rebuilds it: the wire list and head, and the context messages it covered. */
export interface FoldedRequest extends RecordedRequest {
	covers?: Coverage;
}

export interface LedgerFold {
	/** True when the next request opens an epoch: no request yet, a compaction or `epoch` record since, or a changed identity. */
	opensEpoch: boolean;
	/** Why, when `opensEpoch`. */
	cause?: EpochCause;
	/** The last request on the branch whose reply did not fail, rebuilt from its records. */
	lastRequest: FoldedRequest | undefined;
	/** Every element hash already stored on the branch. */
	knownHashes: Set<string>;
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

/** Add `facts` to what the epoch told: a mode or block as last told, names as a union (callable tools also under `CALLABLE_TOOLS`). */
export function tellFacts(into: ToldState, facts: readonly ToldFact[]): void {
	for (const fact of facts) {
		if (fact.kind === "mode") into.modes.set(fact.key, fact.on);
		else if (fact.kind === "block") into.blocks.set(fact.key, fact.hash);
		else {
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
	};
}

/** Fold the branch (root first, as `getBranch()` returns it). `identity` is the live request identity, for epoch detection. */
export function foldBranch(branch: readonly EntryLike[], identity?: RequestIdentity): LedgerFold {
	const blobs = new Map<string, unknown>();
	const told = toldOf([]);
	const produced: { item: PendingRecordData; index: number }[] = [];
	const consumed = new Set<string>();
	let base: FoldedRequest | undefined;
	/** A compaction or `epoch` record after the base: the next request renders everything again. */
	let resetSinceBase: EpochCause | undefined;
	let lastIdentity: RequestIdentity | undefined;
	/** The latest request and what rode it, until its reply settles it. */
	let open: { request: FoldedRequest | undefined; consumed: string[]; facts: ToldFact[] } | undefined;

	const tell = (facts: readonly ToldFact[]) => tellFacts(told, facts);
	/** A new epoch starts with nothing told. */
	const resetTold = () => {
		told.told.clear();
		told.modes.clear();
		told.blocks.clear();
	};
	/** Count what the open request carried and make it the base, unless its reply failed. */
	const settle = (failed: boolean) => {
		if (!open) return;
		if (!failed) {
			for (const id of open.consumed) consumed.add(id);
			tell(open.facts);
			if (open.request) {
				base = open.request;
				resetSinceBase = undefined;
			}
		}
		open = undefined;
	};

	branch.forEach((entry, index) => {
		if (entry.type === "message") {
			if (entry.message?.role === "assistant") settle(entry.message.stopReason === "error");
			return;
		}
		if (entry.type === "compaction") {
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
				resetTold();
				resetSinceBase = record.data.cause;
				return;
			case "request": {
				settle(false);
				const data = record.data;
				for (const [hash, body] of Object.entries(data.blobs)) if (!blobs.has(hash)) blobs.set(hash, body);
				if (lastIdentity && !sameIdentity(lastIdentity, data.identity)) resetTold();
				lastIdentity = data.identity;
				open = { request: rebuild(data, base, blobs), consumed: data.consumed, facts: [] };
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
		.filter(({ item }) => !consumed.has(item.id))
		.map(({ item }) => item);

	const changed = (b: RequestIdentity, live: RequestIdentity): EpochCause | undefined =>
		b.model !== live.model || b.api !== live.api || b.provider !== live.provider ? "model" : b.auth !== live.auth ? "auth" : undefined;
	const cause: EpochCause | undefined = !base ? "first" : (resetSinceBase ?? (identity ? changed(base.identity, identity) : undefined));
	return {
		opensEpoch: cause !== undefined,
		...(cause ? { cause } : {}),
		lastRequest: base,
		knownHashes: new Set(blobs.keys()),
		...told,
		pending,
	};
}
