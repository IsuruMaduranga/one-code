import { describe, expect, it } from "vitest";
import { validateRequest } from "../../extensions/lib/ledger/validate.ts";
import { contentHash, payloadHead, type RecordedRequest, stripMarkers } from "../../extensions/lib/ledger/wire.ts";

const api = "anthropic-messages";
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const addition = (name: string) => ({
	role: "system",
	content: [{ type: "text", text: `The following tools just became available and are ready to use:\n${name}` }, { type: "tool_addition", tool: { type: "tool_reference", name } }],
});
const directive = { role: "system", content: [], output_config: { effort: "high" } };
const body = (messages: unknown[], tools = ["read", "probe_echo"]) => ({
	model: "claude-sonnet-5-5",
	system: "One Code",
	tools: tools.map((name) => ({ name, input_schema: { type: "object" }, ...(name === "probe_echo" ? { defer_loading: true } : {}) })),
	messages,
});
const recorded = (payload: Record<string, unknown>): RecordedRequest => {
	const list = stripMarkers(payload.messages as unknown[]);
	const head = payloadHead(payload, api);
	return { identity: { api, provider: "anthropic", model: "claude-sonnet-5-5", auth: "api-key" }, list, head, hashes: list.map(contentHash), headHash: contentHash(head) };
};

describe("ledger validate", () => {
	it("accepts a well-formed request", () => {
		expect(validateRequest(body([user("one"), addition("probe_echo"), directive]), api)).toEqual([]);
	});

	it("flags a tool addition that names a tool the request does not declare (the H1 and H2 400)", () => {
		const problems = validateRequest(body([user("one"), addition("task_create")]), api);
		expect(problems).toEqual([{ kind: "undeclared", name: "task_create", index: 1 }]);
	});

	it("flags a system message stranded before a user message (one failed reply breaks the session)", () => {
		const problems = validateRequest(body([user("seven"), addition("probe_echo"), user("eight")]), api);
		expect(problems).toEqual([{ kind: "stranded-system", index: 1 }]);
	});

	it("lets the directive-only system message sit anywhere", () => {
		expect(validateRequest(body([user("one"), directive, user("two")]), api)).toEqual([]);
	});

	it("allows system messages to follow each other before the reply", () => {
		const countdown = { role: "system", content: [{ type: "text", text: "<total_tokens>9 tokens left</total_tokens>" }] };
		expect(validateRequest(body([user("one"), addition("probe_echo"), countdown, assistant("1")]), api)).toEqual([]);
	});

	it("flags any element above the append point that differs from the record", () => {
		const sent = body([user("one"), assistant("1")]);
		const next = body([user("one, rewritten"), assistant("1"), user("two")]);
		expect(validateRequest(next, api, recorded(sent))).toEqual([{ kind: "prefix", index: 0 }]);
		expect(validateRequest(body([user("one"), assistant("1"), user("two")]), api, recorded(sent))).toEqual([]);
	});

	it("checks only references on non-Anthropic shapes, which take a system message anywhere", () => {
		const responses = { model: "gpt-6", instructions: "x", tools: [], input: [{ role: "developer", content: "note" }, { role: "user", content: "hi" }] };
		expect(validateRequest(responses, "openai-responses")).toEqual([]);
	});
});
