import { describe, expect, it } from "vitest";
import { CALLABLE_TOOLS, foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { type EntryLike, makeRecord, RECORD, type RecordData, type RecordKind, stateOnBranch } from "../../extensions/lib/ledger/records.ts";
import { encodeRequest, recordedRequest, type WirePayload } from "../../extensions/lib/ledger/wire.ts";

const identity = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", auth: "api-key" };
const live = identity;
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
		const delta = encodeRequest(fold.lastRequest, recordedRequest(payload, opts.identity ?? identity), fold.knownHashes);
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
		b.message("assistant");
		const fold = foldBranch(b.entries, live);
		expect(fold.opensEpoch).toBe(false);
		expect(fold.lastRequest?.list).toEqual([user("one"), assistant("1"), user("two")]);
		expect(fold.lastRequest?.head).toMatchObject({ system: "One Code", tools: [] });
		expect(fold.knownHashes.size).toBeGreaterThanOrEqual(4);
	});

	it.each(["error", "aborted"])("skips a request whose reply ended %s: the next request extends the last answered one", (stopReason) => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.message("assistant");
		b.request(body([user("one"), assistant("1"), user("two")]));
		b.message("assistant", stopReason);
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
		expect(stateOnBranch(b.entries, "permission-mode")).toBe("acceptEdits");
		expect(stateOnBranch(b.entries, "ultracode")).toBe(true);
	});

	it("keeps durable state across a compaction", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		b.compaction();
		expect(stateOnBranch(b.entries, "permission-mode")).toBe("plan");
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

	it("opens an epoch at an api or provider change with the same model id and auth", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.message("assistant");
		expect(foldBranch(b.entries, { ...live, provider: "openrouter" }).cause).toBe("model");
		expect(foldBranch(b.entries, { ...live, api: "openai-completions" }).cause).toBe("model");
	});

	it("opens an epoch at an epoch record, with nothing told", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.record("told", { facts: [{ kind: "tools", names: ["web_fetch"] }] });
		b.message("assistant");
		b.record("epoch", { cause: "fold" });
		const fold = foldBranch(b.entries, live);
		expect(fold.opensEpoch).toBe(true);
		expect(fold.cause).toBe("fold");
		expect(fold.told.size).toBe(0);
	});

	it("after a failed model hop, extends the first model's epoch again, with what it told", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.record("told", { facts: [{ kind: "tools", names: ["web_fetch"] }] });
		b.message("assistant");
		b.record("epoch", { cause: "model" });
		b.request(body([user("one"), assistant("1"), user("two")]), { identity: { ...identity, model: "claude-haiku-4-5" } });
		b.message("assistant", "error");
		const fold = foldBranch(b.entries, live);
		expect(fold.opensEpoch).toBe(false);
		expect(fold.lastRequest?.list).toEqual([user("one")]);
		expect(fold.told.get("tools")).toEqual(new Set(["web_fetch"]));
	});

	it("after a failed reply, keeps exactly what the epoch told before it, and tells on from there", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.record("told", { facts: [{ kind: "tools", names: ["web_fetch"], callable: true }, { kind: "mode", key: "plan", on: true }, { kind: "block", key: "menu", hash: "h1" }] });
		b.message("assistant");
		b.request(body([user("one"), assistant("1"), user("two")]));
		b.record("told", { facts: [{ kind: "tools", names: ["probe_echo", "web_fetch"], callable: true }, { kind: "tools", names: ["web_fetch"], removed: true }, { kind: "mode", key: "plan", on: false }, { kind: "block", key: "menu", hash: "h2" }] });
		b.message("assistant", "error");
		let fold = foldBranch(b.entries, live);
		expect(fold.lastRequest?.list).toEqual([user("one")]);
		expect(fold.told).toEqual(new Map([["tools", new Set(["web_fetch"])], [CALLABLE_TOOLS, new Set(["web_fetch"])]]));
		expect(fold.modes).toEqual(new Map([["plan", true]]));
		expect(fold.blocks).toEqual(new Map([["menu", "h1"]]));
		b.request(body([user("one"), assistant("1"), user("again")]));
		b.record("told", { facts: [{ kind: "tools", names: ["probe_echo"] }] });
		b.message("assistant");
		fold = foldBranch(b.entries, live);
		expect(fold.told.get("tools")).toEqual(new Set(["web_fetch", "probe_echo"]));
		expect(fold.told.get(CALLABLE_TOOLS)).toEqual(new Set(["web_fetch"]));
	});

	it("after a failed model hop with no epoch record, keeps what the first model's epoch told", () => {
		const b = new Branch();
		b.request(body([user("one")]));
		b.record("told", { facts: [{ kind: "tools", names: ["web_fetch"] }, { kind: "mode", key: "plan", on: true }, { kind: "block", key: "menu", hash: "h1" }] });
		b.message("assistant");
		b.request(body([user("one"), assistant("1"), user("two")]), { identity: { ...identity, model: "claude-haiku-4-5" } });
		b.record("told", { facts: [{ kind: "tools", names: ["probe_echo"] }, { kind: "mode", key: "plan", on: false }, { kind: "block", key: "menu", hash: "h2" }] });
		b.message("assistant", "aborted");
		const fold = foldBranch(b.entries, live);
		expect(fold.opensEpoch).toBe(false);
		expect(fold.lastRequest?.identity.model).toBe(identity.model);
		expect(fold.told).toEqual(new Map([["tools", new Set(["web_fetch"])]]));
		expect(fold.modes).toEqual(new Map([["plan", true]]));
		expect(fold.blocks).toEqual(new Map([["menu", "h1"]]));
	});

	it("takes tools told gone out of the told set, callable ones included", () => {
		const b = new Branch();
		b.record("told", { facts: [{ kind: "tools", names: ["mcp__a__x", "web_fetch"], callable: true }] });
		b.record("told", { facts: [{ kind: "tools", names: ["mcp__a__x"], removed: true }] });
		const fold = foldBranch(b.entries, live);
		expect(fold.told.get("tools")).toEqual(new Set(["web_fetch"]));
		expect(fold.told.get(CALLABLE_TOOLS)).toEqual(new Set(["web_fetch"]));
	});

	it("keeps pending items until a request consumes them, latest per key", () => {
		const b = new Branch();
		b.record("pending", { id: "p1", text: "hook said hi" });
		b.record("pending", { id: "p2", key: "model", text: "/model a" });
		b.record("pending", { id: "p3", key: "model", text: "/model b" });
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["p1", "p3"]);
		b.request(body([user("one")]), { consumed: ["p1"] });
		b.message("assistant");
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["p3"]);
	});

	it("drops an undelivered `untilCompaction` item (a post-compaction restore) at a later compaction, and keeps the others", () => {
		const b = new Branch();
		b.compaction();
		b.record("pending", { id: "restore-1", text: "a.ts as it was", untilCompaction: true });
		b.record("pending", { id: "hook", text: "PostCompact context" });
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["restore-1", "hook"]);
		b.compaction();
		b.record("pending", { id: "restore-2", text: "a.ts as it is", untilCompaction: true });
		expect(foldBranch(b.entries, live).pending.map((p) => p.id)).toEqual(["hook", "restore-2"]);
	});

	it("sees only the branch it is given: an abandoned branch's records are simply absent", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		const fork = b.entries.slice();
		b.record("state", { key: "permission-mode", value: "acceptEdits" });
		b.record("pending", { id: "p1", text: "only on the abandoned branch" });
		expect(stateOnBranch(fork, "permission-mode")).toBe("plan");
		expect(foldBranch(fork, live).pending).toEqual([]);
	});

	it("ignores records of another format version", () => {
		const b = new Branch();
		b.record("state", { key: "permission-mode", value: "plan" });
		(b.entries[0].data as { v: number }).v = 99;
		expect(stateOnBranch(b.entries, "permission-mode")).toBeUndefined();
	});
});
