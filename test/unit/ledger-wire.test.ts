import { describe, expect, it } from "vitest";
import { contentHash, encodeRequest, listKey, payloadHead, recordedRequest } from "../../extensions/lib/ledger/wire.ts";

const identity = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", auth: "api-key" };
const user = (text: string, marked = false) => ({ role: "user", content: [{ type: "text", text, ...(marked ? { cache_control: { type: "ephemeral" } } : {}) }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
	model: "claude-sonnet-5-5",
	max_tokens: 64000,
	system: [{ type: "text", text: "You are One Code." }],
	tools: [{ name: "read", input_schema: { type: "object" } }],
	messages,
	...extra,
});

/** What the fold would rebuild from a record: the list and head as sent, markers stripped. */
const recorded = (payload: Record<string, unknown>, id = identity) => recordedRequest(payload, id);

describe("ledger wire", () => {
	it("finds the list under each API's own key", () => {
		expect(listKey("anthropic-messages")).toBe("messages");
		expect(listKey("openai-completions")).toBe("messages");
		expect(listKey("openai-responses")).toBe("input");
		expect(listKey("openai-codex-responses")).toBe("input");
		expect(listKey("google-generative-ai")).toBe("contents");
	});

	it("hashes content, not key order or cache markers", () => {
		expect(contentHash({ a: 1, b: [1, 2] })).toBe(contentHash({ b: [1, 2], a: 1 }));
		expect(contentHash(user("hi", true))).toBe(contentHash(user("hi")));
		expect(contentHash(user("hi"))).not.toBe(contentHash(user("ho")));
	});

	it("keeps the output cap out of the head, so a cache warm's max_tokens 1 is the same head", () => {
		const head = payloadHead(body([user("hi")]), identity.api);
		expect(head).not.toHaveProperty("messages");
		expect(head).not.toHaveProperty("max_tokens");
		expect(head).toHaveProperty("system");
		expect(head).toHaveProperty("tools");
		expect(payloadHead(body([user("hi")], { max_tokens: 1 }), identity.api)).toEqual(head);
	});

	it("records the first request whole and a later one as a delta with only new blobs", () => {
		const first = body([user("one", true)]);
		const r1 = encodeRequest(undefined, recorded(first), new Set());
		expect(r1?.keep).toBe(0);
		expect(r1?.append).toHaveLength(1);
		expect(Object.keys(r1?.blobs ?? {})).toEqual(expect.arrayContaining([...(r1?.append ?? []), r1?.head]));

		const second = body([user("one"), assistant("1"), user("two", true)]);
		const known = new Set([...(r1?.append ?? []), r1?.head as string]);
		const r2 = encodeRequest(recorded(first), recorded(second), known);
		expect(r2?.keep).toBe(1);
		expect(r2?.append).toEqual([contentHash(assistant("1")), contentHash(user("two"))]);
		expect(r2?.head).toBe(r1?.head);
		expect(Object.keys(r2?.blobs ?? {}).sort()).toEqual([...(r2?.append ?? [])].sort());
	});

	it("records nothing for a request that adds nothing (a cache warm or a provider retry)", () => {
		const payload = body([user("one"), assistant("1"), user("two", true)]);
		const base = recorded(payload);
		const known = new Set([...base.hashes, base.headHash]);
		expect(encodeRequest(base, recorded(payload), known)).toBeUndefined();
		expect(encodeRequest(base, recorded({ ...payload, max_tokens: 1 }), known)).toBeUndefined();
	});

	it("records a changed head by its new hash", () => {
		const first = body([user("one")]);
		const second = body([user("one"), assistant("1"), user("two")], { output_config: { effort: "high" } });
		const r2 = encodeRequest(recorded(first), recorded(second), new Set());
		expect(r2?.head).toBe(contentHash(payloadHead(second, identity.api)));
		expect(r2?.blobs).toHaveProperty(r2?.head as string);
	});

	it("keeps only the elements that still match when the list diverges from the record", () => {
		const first = body([user("one"), assistant("1"), user("two")]);
		const forked = body([user("one"), assistant("1"), user("three")]);
		const r = encodeRequest(recorded(first), recorded(forked), new Set());
		expect(r?.keep).toBe(2);
		expect(r?.append).toEqual([contentHash(user("three"))]);
	});
});
