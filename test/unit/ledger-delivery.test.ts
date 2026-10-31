/**
 * "Delivered means the model saw it and the branch kept it" (lib/ledger/fold.ts
 * header, lifecycle-grid-hunt round 3: R3-M6 to M9, L1, L2): a request counts
 * only with its own reply on the branch, and a pi cache warm never records.
 */
import { describe, expect, it } from "vitest";
import { stripMarkers } from "../../extensions/lib/ledger/wire.ts";
import { LedgerSim } from "./helpers/ledger-sim.ts";

const texts = LedgerSim.texts;

describe("a request counts only with its own reply", () => {
	it("delivers again the pending items of a request no reply followed (a quit mid-stream), on the base before it", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.pending("hook context");
		s.message("user", "U2");
		await s.requestWithoutReply();
		// A new process resumes the file.
		s.load();
		await s.sessionStart();
		expect(s.fold().pending.map((item) => item.text)).toEqual(["hook context"]);
		expect(s.fold().lastRequest?.list).toEqual([{ role: "user", content: [{ type: "text", text: "U1" }] }]);
		s.message("user", "U3");
		const next = await s.request("A3");
		expect(s.plans.at(-1)?.epoch).toBe(false);
		expect(texts(next).join(" ")).toContain("<rem hook context>");
	});

	it("does not count a request pi omitted the reply of (a recovered length stop): its pending items go out again", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.pending("one-shot");
		s.message("user", "U2");
		await s.request("cut off", "length");
		s.omit(s.entries.findLast((entry) => entry.type === "message")?.id ?? "");
		expect(s.fold().pending.map((item) => item.text)).toEqual(["one-shot"]);
		const retry = await s.request("A2");
		expect(texts(retry).join(" ")).toContain("<rem one-shot>");
	});

	it("takes a btw fork's side answer for no reply to the parent's request copied mid-stream", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.message("user", "U2");
		await s.requestWithoutReply();
		// The fork copies the file now, then adds the side question and its answer.
		s.message("user", "btw Q");
		s.message("assistant", "btw A");
		s.message("user", "fork task");
		const first = await s.request("fork reply");
		// The fork extends the parent's last answered request, not the one in flight (whose list may end in a system message expecting its reply).
		expect(s.plans.at(-1)?.epoch).toBe(false);
		expect(s.plans.at(-1)?.base?.list).toHaveLength(1);
		expect(texts(first)).toEqual(["user:U1", "assistant:A1", "user:U2", "user:btw Q", "assistant:btw A", "user:fork task"]);
	});
});

describe("a cache warm never records", () => {
	it("resends the request it warms, as sent, and the next request extends the base", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.message("user", "U2");
		const sent = await s.request("A2");
		const records = s.records("request").length;
		// A deferred tool registered during a long tool call: pi's own rendering of the warm now differs.
		s.tools.push({ name: "late" });
		const warm = await s.warm();
		expect(s.records("request").length).toBe(records);
		expect({ ...warm, max_tokens: sent.max_tokens }).toEqual(sent);
		expect(warm.max_tokens).toBe(1);
		s.message("user", "U3");
		await s.request("A3");
		expect(s.plans.at(-1)?.epoch).toBe(false);
	});

	it("records nothing after an aborted reply, and the pending item it carried is delivered next", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.pending("reminder");
		s.message("user", "U2");
		await s.request("stopped", "aborted");
		const records = s.records("request").length;
		await s.warm();
		expect(s.records("request").length).toBe(records);
		s.message("user", "U3");
		const next = await s.request("A3");
		expect(s.plans.at(-1)?.epoch).toBe(false);
		expect(texts(next).join(" ")).toContain("<rem reminder>");
	});

	it("after a /reload, warms the branch's last request whole, not the tail the old instance cut", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.message("user", "U2");
		const sent = await s.request("A2");
		s.load();
		await s.sessionStart("reload");
		const records = s.records("request").length;
		const warm = await s.warm();
		expect(texts(warm)).toEqual(texts(sent));
		expect(s.records("request").length).toBe(records);
	});

	it("records pi-ai's second send of a request under the same plan (its strict-tools fallback), and a warm then sends that one", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1", "stop", 2);
		const fold = s.fold();
		expect(fold.lastRequest?.list).toHaveLength(1);
		const warm = await s.warm();
		expect(texts(warm)).toEqual(["user:U1"]);
	});

	it("records pi-ai's strict-tools fallback even when the request's cap was clamped to the warm cap near the end of the window", async () => {
		const s = new LedgerSim();
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.message("user", "U2");
		const records = s.records("request").length;
		// pi-ai clamps max_tokens to the window's room (clampMaxTokensToContext), as low as 1; its
		// fallback sends each tool again in the same call with its non-strict input schema.
		const lenient = [{ name: "read", input_schema: { type: "object" } }];
		const sent = await s.request("A2", "stop", 2, 12, (payload) => ({ ...payload, tools: lenient }));
		expect(sent.tools).toEqual(lenient);
		expect(sent.max_tokens).toBe(12);
		expect(s.records("request").length).toBe(records + 2);
		expect(s.fold().lastRequest?.head.tools).toEqual(lenient);
		// A warm after it is its own provider call: still a warm, resending the fallback.
		const warm = await s.warm();
		expect(s.records("request").length).toBe(records + 2);
		expect({ ...warm, max_tokens: sent.max_tokens }).toEqual(sent);
	});
});

describe("a /fork routes to its parent's cache host (R3-M22)", () => {
	it("sends the parent's session-affinity headers while it extends the parent's record", async () => {
		const s = new LedgerSim();
		s.model = { api: "anthropic-messages", provider: "openrouter", id: "anthropic/claude-sonnet-5-5", baseUrl: "https://openrouter.ai/api/v1" };
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		expect(await s.headers()).toEqual({});
		// /fork: the same entries under a new session id.
		s.sessionId = "s2";
		s.load();
		await s.sessionStart("fork");
		s.message("user", "U2");
		await s.context();
		expect(await s.headers()).toEqual({ "x-session-id": "s1" });
	});

	it("sends the recorded request's affinity headers with a cache warm after a /reload of the fork", async () => {
		const s = new LedgerSim();
		s.model = { api: "anthropic-messages", provider: "openrouter", id: "anthropic/claude-sonnet-5-5", baseUrl: "https://openrouter.ai/api/v1" };
		await s.sessionStart();
		s.message("user", "U1");
		await s.request("A1");
		s.sessionId = "s2";
		s.load();
		await s.sessionStart("fork");
		s.message("user", "U2");
		await s.request("A2");
		// /reload: no plan in the new instance, so the warm replays the branch's last request.
		s.load();
		await s.sessionStart("reload");
		const warm = await s.warm();
		expect(warm).toEqual({ ...s.sent.at(-1), max_tokens: 1 });
		expect(await s.headers()).toEqual({ "x-session-id": "s1" });
	});
});

describe("stripMarkers", () => {
	it("keeps a cache_control field inside a recorded tool call's input and a tool's schema", () => {
		const call = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write", input: { cache_control: "keep me", nested: [{ cachePoint: { type: "default" } }] }, cache_control: { type: "ephemeral" } }] };
		expect(stripMarkers(call)).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write", input: { cache_control: "keep me", nested: [{ cachePoint: { type: "default" } }] } }] });
		const tool = { name: "t", input_schema: { type: "object", properties: { cache_control: { type: "string" } } }, cache_control: { type: "ephemeral" } };
		expect(stripMarkers(tool)).toEqual({ name: "t", input_schema: { type: "object", properties: { cache_control: { type: "string" } } } });
	});
});
