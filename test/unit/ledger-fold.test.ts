import { describe, expect, it } from "vitest";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { type EntryLike, makeRecord, RECORD, type RecordData, type RecordKind } from "../../extensions/lib/ledger/records.ts";
import { encodeRequest, type WirePayload } from "../../extensions/lib/ledger/wire.ts";

const identity = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", auth: "api-key" };
const live = { model: identity.model, auth: identity.auth };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const body = (messages: unknown[]): WirePayload => ({ model: identity.model, max_tokens: 64000, system: "One Code", tools: [], messages });

/** Builds a branch root first, the way `getBranch()` returns it. */
class Branch {
	entries: EntryLike[] = [];
	private add(entry: Omit<EntryLike, "id" | "parentId">): EntryLike {
		const full = { ...entry, id: `e${this.entries.length + 1}`, parentId: this.entries.at(-1)?.id ?? null } as EntryLike;
		this.entries.push(full);
		return full;
	}
	record<K extends RecordKind>(kind: K, fields: Omit<RecordData[K], "v" | "by">) {
		return this.add({ type: "custom", customType: RECORD[kind], data: makeRecord(kind, "0.6.0", fields) });
	}
	/** A request as the core would record it, against everything recorded so far. */
	request(payload: WirePayload, opts: { identity?: typeof identity; consumed?: string[] } = {}) {
		const fold = foldBranch(this.entries, live);
		const delta = encodeRequest(fold.lastRequest, payload, opts.identity ?? identity, fold.knownHashes);
		if (!delta) throw new Error("test request added nothing");
		return this.record("request", { ...delta, consumed: opts.consumed ?? [] });
	}
	message(role: string, stopReason?: string) {
		return this.add({ type: "message", message: { role, ...(stopReason ? { stopReason } : {}) } });
	}
	compaction() {
		return this.add({ type: "compaction" });
	}
	warm() {
		return this.add({ type: "usage" });
	}
}

describe("ledger fold", () => {
	it("opens an epoch on an empty branch", () => {
		const fold = foldBranch([], live);
		expect(fold.opensEpoch).toBe(true);
		expect(fold.lastRequest).toBeUndefined();
		expect(fold.pending).toEqual([]);
	});

	it("rebuilds the last request's list and head byte for byte from the deltas", () => {
		const b = new Branch();
		b.message("user");
		b.request(body([user("one")]));
		b.message("assistant");
		b.message("user");
		b.request(body([user("one"), assistant("1"), user("two")]));
		const fold = foldBranch(b.entries, live);
		expect(fold.opensEpoch).toBe(false);
		expect(fold.lastRequest?.list).toEqual([user("one"), assistant("1"), user("two")]);
		expect(fold.lastRequest?.head).toMatchObject({ system: "One Code", tools: [] });
		expect(fold.knownHashes.size).toBeGreaterThanOrEqual(4);
	});

	it("skips a request whose reply failed: the next request extends the last answered one", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.message("assistant");
		b.request(body([user("one"), assistant("1"), user("two")]));
		b.message("assistant", "error");
		expect(foldBranch(b.entries, live).lastRequest?.list).toEqual([user("one")]);
	});

	it("skips pi's cache-warm usage entries", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.warm();
		b.message("assistant");
		expect(foldBranch(b.entries, live).lastRequest?.list).toEqual([user("one")]);
	});

	it("opens an epoch after a compaction and at a model or auth change", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.message("assistant");
		expect(foldBranch(b.entries, live).opensEpoch).toBe(false);
		expect(foldBranch(b.entries, { ...live, model: "claude-haiku-4-5" }).opensEpoch).toBe(true);
		expect(foldBranch(b.entries, { ...live, auth: "oauth" }).opensEpoch).toBe(true);
		b.compaction();
		expect(foldBranch(b.entries, live).opensEpoch).toBe(true);
	});

	it("lets the latest state entry per key win", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		b.record("state", { key: "ultracode", value: true });
		b.record("state", { key: "permission-mode", value: "acceptEdits" });
		const fold = foldBranch(b.entries, live);
		expect(fold.state.get("permission-mode")).toBe("acceptEdits");
		expect(fold.state.get("ultracode")).toBe(true);
	});

	it("keeps durable state across a compaction", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		b.compaction();
		expect(foldBranch(b.entries, live).state.get("permission-mode")).toBe("plan");
	});

	it("unions told facts within the epoch and starts them empty after a compaction", () => {
		const b = new Branch();
		b.record("told", { facts: [{ kind: "tools", names: ["web_fetch"] }, { kind: "mode", key: "plan", on: true }] });
		b.record("told", { facts: [{ kind: "tools", names: ["probe_echo"] }, { kind: "skills", names: ["review"] }] });
		let fold = foldBranch(b.entries, live);
		expect([...(fold.told.get("tools") ?? [])].sort()).toEqual(["probe_echo", "web_fetch"]);
		expect(fold.told.get("skills")).toEqual(new Set(["review"]));
		expect(fold.modes.get("plan")).toBe(true);
		b.compaction();
		fold = foldBranch(b.entries, live);
		expect(fold.told.get("tools") ?? new Set()).toEqual(new Set());
		expect(fold.modes.size).toBe(0);
	});

	it("keeps pending items until a request consumes them, latest per key", () => {
		const b = new Branch();
		b.record("pending", { id: "p1", source: "hook:SessionStart", text: "hook said hi" });
		b.record("pending", { id: "p2", source: "local-command", key: "model", text: "/model a" });
		b.record("pending", { id: "p3", source: "local-command", key: "model", text: "/model b" });
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["p1", "p3"]);
		b.request(body([user("one")]), { consumed: ["p1"] });
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["p3"]);
	});

	it("drops file restores and PostCompact context produced before the latest compaction", () => {
		const b = new Branch();
		b.record("pending", { id: "p1", source: "file-restore", text: "old restore" });
		b.record("pending", { id: "p2", source: "hook:PostCompact", text: "old hook" });
		b.record("pending", { id: "p3", source: "notification", text: "a task finished" });
		b.compaction();
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["p3"]);
	});

	it("sees only the branch it is given: an abandoned branch's records are simply absent", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		const fork = b.entries.slice();
		b.record("state", { key: "permission-mode", value: "acceptEdits" });
		b.record("pending", { id: "p1", source: "notification", text: "only on the abandoned branch" });
		const fold = foldBranch(fork, live);
		expect(fold.state.get("permission-mode")).toBe("plan");
		expect(fold.pending).toEqual([]);
	});

	it("ignores records of another format version", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		(b.entries[0].data as { v: number }).v = 99;
		expect(foldBranch(b.entries, live).state.has("permission-mode")).toBe(false);
	});
});
