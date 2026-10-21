import { describe, expect, it } from "vitest";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { planRequest } from "../../extensions/lib/ledger/plan.ts";
import { makeRecord, RECORD } from "../../extensions/lib/ledger/records.ts";
import { deliveredAfterRepair, repairRequest, validateRequest } from "../../extensions/lib/ledger/validate.ts";
import { contentHash, eagerToolNames, isTrailer, mergeDeclarations, payloadHead, preludeLength, recordedRequest, spliceRequest, withRecordedHead } from "../../extensions/lib/ledger/wire.ts";

const identity = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", auth: "key" };
const mark = { type: "ephemeral" };
const user = (text: string, marked = false) => ({ role: "user", content: [{ type: "text", text, ...(marked ? { cache_control: mark } : {}) }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const directive = { role: "system", content: [], output_config: { effort: "high" } };
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, input_schema: { type: "object" }, ...extra });

const recorded = (payload: Record<string, unknown>, api = identity.api) => recordedRequest(payload, { ...identity, api });

describe("planRequest", () => {
	const messages = [{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }, { role: "user", timestamp: 3 }];
	const branchWith = (covers: { count: number; role: string; timestamp: number }) => {
		const { list, head, hashes, headHash } = recorded({ model: identity.model, system: "s", messages: [user("one")] });
		const blobs = Object.fromEntries([...list.map((m, i) => [hashes[i], m]), [headHash, head]]);
		return [{ type: "custom", id: "r1", parentId: null, customType: RECORD.request, data: makeRecord("request", "0.6.0", { identity, keep: 0, append: hashes, head: headHash, blobs, consumed: [], covers }) }];
	};

	it("opens an epoch on an empty branch, covering every message", () => {
		const { plan, tailStart } = planRequest(foldBranch([]), messages);
		expect(plan.epoch).toBe(true);
		expect(plan.cause).toBe("first");
		expect(tailStart).toBe(0);
		expect(plan.covers).toEqual({ count: 3, role: "user", timestamp: 3 });
	});

	it("extends the base when the messages it covered are still there, and cuts them", () => {
		const { plan, tailStart } = planRequest(foldBranch(branchWith({ count: 1, role: "user", timestamp: 1 })), messages);
		expect(plan.epoch).toBe(false);
		expect(plan.base?.list).toEqual([user("one")]);
		expect(tailStart).toBe(1);
	});

	it("opens an epoch when the covered messages changed, or nothing came after them", () => {
		expect(planRequest(foldBranch(branchWith({ count: 1, role: "user", timestamp: 9 })), messages).plan.cause).toBe("coverage");
		expect(planRequest(foldBranch(branchWith({ count: 5, role: "user", timestamp: 1 })), messages).plan.cause).toBe("coverage");
		expect(planRequest(foldBranch(branchWith({ count: 3, role: "user", timestamp: 3 })), messages).plan.cause).toBe("empty");
	});
});

describe("spliceRequest", () => {
	it("puts the base's list, without its trailing directive, in front of pi's tail", () => {
		const base = recorded({ model: "m", system: [{ type: "text", text: "s" }], tools: [tool("read")], messages: [user("one"), directive] });
		const payload = { model: "m", system: [{ type: "text", text: "s", cache_control: mark }], tools: [tool("read")], messages: [directive, assistant("1"), user("two", true), directive], max_tokens: 100 };
		const out = spliceRequest(base, payload, identity.api);
		expect(out.messages).toEqual([user("one"), directive, assistant("1"), user("two", true), directive]);
		expect(out.system).toEqual(payload.system);
		expect(out.max_tokens).toBe(100);
	});

	it("drops the prompt element Chat Completions and Responses put first in a tail", () => {
		expect(preludeLength([{ role: "developer", content: "p" }, { role: "user", content: "x" }], "openai-responses")).toBe(1);
		expect(preludeLength([{ role: "system", content: "p" }], "openai-completions")).toBe(1);
		expect(preludeLength([{ role: "system", content: [] }], "anthropic-messages")).toBe(0);
		expect(preludeLength([{ role: "user", content: "x" }], "openai-codex-responses")).toBe(0);
		const base = recorded({ model: "m", input: [{ role: "developer", content: "p" }, { role: "user", content: "a" }] }, "openai-responses");
		const out = spliceRequest(base, { model: "m", input: [{ role: "developer", content: "p" }, { role: "assistant", content: "b" }] }, "openai-responses");
		expect(out.input).toEqual([{ role: "developer", content: "p" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }]);
	});

	it("does not declare again a tool a Responses load item in the base already declared", () => {
		const fn = (name: string) => ({ type: "function", name, parameters: {} });
		const base = recorded({ model: "m", tools: [fn("read")], input: [{ role: "user", content: "a" }, { type: "additional_tools", role: "developer", tools: [fn("cron_list")] }, { type: "function_call_output", call_id: "c", output: "loaded" }] }, "openai-responses");
		const out = spliceRequest(base, { model: "m", tools: [fn("read"), fn("cron_list")], input: [{ type: "function_call", name: "cron_list", call_id: "d", arguments: "{}" }] }, "openai-responses");
		expect(out.tools).toEqual([fn("read")]);
	});

	it("knows each API's per-request trailer", () => {
		expect(isTrailer(directive, "anthropic-messages")).toBe(true);
		expect(isTrailer({ role: "system", content: [{ type: "text", text: "x" }] }, "anthropic-messages")).toBe(false);
		expect(isTrailer({ type: "configuration_update", reasoning: { effort: "high" } }, "openai-responses")).toBe(true);
		expect(isTrailer(directive, "openai-completions")).toBe(false);
	});
});

describe("the recorded head", () => {
	it("keeps the recorded system prompt and tools, appends new tools, and never removes one", () => {
		const head = payloadHead({ system: "old prompt", tools: [tool("read"), tool("probe", { defer_loading: true })] }, identity.api);
		const live = { system: "new prompt", tools: [tool("read", { description: "changed" }), tool("late", { defer_loading: true })], thinking: { type: "adaptive" } };
		const out = withRecordedHead(live, head, identity.api);
		expect(out.system).toBe("old prompt");
		expect(out.tools).toEqual([tool("read"), tool("probe", { defer_loading: true }), tool("late", { defer_loading: true })]);
		expect(out.thinking).toEqual({ type: "adaptive" });
	});

	it("moves pi's tools marker to the last tool that is not deferred", () => {
		const merged = mergeDeclarations([tool("read"), tool("probe", { defer_loading: true })], [tool("read"), tool("probe", { cache_control: mark })]);
		expect(merged).toEqual([tool("read", { cache_control: mark }), tool("probe", { defer_loading: true })]);
	});

	it("keeps the recorded prompt_cache_key, so a fork extending its parent's request routes to the parent's cache", () => {
		const head = payloadHead({ instructions: "p", prompt_cache_key: "parent-session", input: [] }, "openai-responses");
		expect(withRecordedHead({ instructions: "p", prompt_cache_key: "fork-session" }, head, "openai-responses").prompt_cache_key).toBe("parent-session");
		// Codex sends the session's own id as a header too: the key must agree with it.
		const codex = payloadHead({ instructions: "p", prompt_cache_key: "parent-session", input: [] }, "openai-codex-responses");
		expect(withRecordedHead({ instructions: "p", prompt_cache_key: "fork-session" }, codex, "openai-codex-responses").prompt_cache_key).toBe("fork-session");
	});

	it("keeps every beta an earlier request needed", () => {
		const head = payloadHead({ system: "s", betas: ["mid-conversation-system"] }, identity.api);
		expect(withRecordedHead({ system: "s", betas: ["other"] }, head, identity.api).betas).toEqual(["mid-conversation-system", "other"]);
	});

	it("keeps pi's Bedrock cache point after a recorded system prompt that differs from the live one", () => {
		const head = payloadHead({ messages: [], system: [{ text: "old prompt" }, { cachePoint: { type: "default" } }] }, "bedrock-converse-stream");
		const out = withRecordedHead({ system: [{ text: "new prompt" }, { cachePoint: { type: "default" } }] }, head, "bedrock-converse-stream");
		expect(out.system).toEqual([{ text: "old prompt" }, { cachePoint: { type: "default" } }]);
	});

	it("merges Google's function declarations and Bedrock's tool specs by name", () => {
		const googleHead = payloadHead({ contents: [], config: { systemInstruction: "s", tools: [{ functionDeclarations: [{ name: "a" }] }] } }, "google-generative-ai");
		const google = withRecordedHead({ config: { systemInstruction: "changed", tools: [{ functionDeclarations: [{ name: "b" }] }], abortSignal: "live" } }, googleHead, "google-generative-ai");
		expect(google.config).toEqual({ systemInstruction: "s", tools: [{ functionDeclarations: [{ name: "a" }, { name: "b" }] }], abortSignal: "live" });
		const bedrockHead = payloadHead({ messages: [], toolConfig: { tools: [{ toolSpec: { name: "a" } }] } }, "bedrock-converse-stream");
		const bedrock = withRecordedHead({ toolConfig: { tools: [{ toolSpec: { name: "b" } }, { cachePoint: { type: "default" } }] } }, bedrockHead, "bedrock-converse-stream");
		expect((bedrock.toolConfig as { tools: unknown[] }).tools).toEqual([{ toolSpec: { name: "a" } }, { toolSpec: { name: "b" } }, { cachePoint: { type: "default" } }]);
	});
});

describe("eagerToolNames", () => {
	it("names the tools a recorded head declares eagerly, in any API's shape, never a deferred one", () => {
		expect(eagerToolNames({ tools: [tool("read"), tool("cron_list", { defer_loading: true })] })).toEqual(new Set(["read"]));
		expect(eagerToolNames({ tools: [{ type: "function", function: { name: "cron_list" } }] })).toEqual(new Set(["cron_list"]));
		expect(eagerToolNames({ toolConfig: { tools: [{ toolSpec: { name: "a" } }, { cachePoint: { type: "default" } }] } })).toEqual(new Set(["a"]));
		expect(eagerToolNames({ config: { tools: [{ functionDeclarations: [{ name: "g" }] }] } })).toEqual(new Set(["g"]));
	});
});

describe("repairRequest", () => {
	it("drops a reference to an undeclared tool and a stranded system message", () => {
		const addition = (name: string) => ({ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name } }] });
		const payload = { tools: [tool("read")], messages: [user("one"), addition("gone"), { role: "system", content: [{ type: "text", text: "budget" }] }, user("two")] };
		const problems = validateRequest(payload, identity.api);
		expect(problems.map((p) => p.kind).sort()).toEqual(["stranded-system", "stranded-system", "undeclared"]);
		const repaired = repairRequest(payload, identity.api, problems);
		expect(validateRequest(repaired, identity.api)).toEqual([]);
		expect(repaired.messages).toEqual([user("one"), user("two")]);
	});

	it("records as delivered only what the repaired request still carries", () => {
		const addition = (name: string) => ({ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name } }] });
		const payload = { tools: [tool("read"), tool("probe")], messages: [user("one"), addition("probe"), user("note: <system-reminder>a file changed</system-reminder>")] };
		const repaired = repairRequest(payload, identity.api, validateRequest(payload, identity.api));
		const delivered = deliveredAfterRepair(
			repaired,
			identity.api,
			{ consumed: ["kept", "dropped"], facts: [{ kind: "tools", names: ["probe"], callable: true }, { kind: "tools", names: ["listed"] }] },
			[{ id: "kept", text: "a file changed" }, { id: "dropped", text: "only on the stranded message" }],
		);
		expect(delivered).toEqual({ consumed: ["kept"], facts: [{ kind: "tools", names: ["listed"] }] });
	});
});
