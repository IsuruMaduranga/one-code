/**
 * The ledger on Codex's effort items from pi 1.6.1 (findings §110): pi sends
 * the first effort its rendering meets as the top-level `reasoning.effort`
 * and a `configuration_update` item only where the effort changes. The
 * ledger has pi render only a request's tail, so the splice must keep the
 * record's top level and open the tail with pi's effort where the two
 * differ. The oracle is pi-ai's own renderer: every spliced request must
 * equal pi's rendering of the whole conversation, and extend the request
 * before it, across thinking-level changes.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appendPoint, recordedRequest, spliceRequest, withTailEffort } from "../../extensions/lib/request/ledger/wire.ts";
import { forkRequestPayload } from "../../extensions/lib/side-calls/request-replay.ts";

type Body = Record<string, unknown>;
const api = "openai-codex-responses";
const model = { id: "gpt-6.1-sol", name: "gpt-6.1-sol", provider: "openai-codex", api, reasoning: true, input: ["text"], compat: { supportsMidConvoEffort: true } };
const identity = { api, provider: model.provider, model: model.id, auth: "oauth", effortMarkers: true };

const shared = await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js")).href);

let clock = 0;
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: ++clock });
const reply = (text: string, level: string) => {
	const at = ++clock;
	return {
	role: "assistant",
	api,
	provider: model.provider,
	model: model.id,
	// The API's item id, as a real reply carries it (pi numbers a reply without one by its position in the rendering).
	content: [{ type: "text", text, textSignature: JSON.stringify({ v: 1, id: `msg_${at}` }) }],
	providerThinkingLevel: level,
	stopReason: "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	timestamp: at,
	};
};

/** pi 1.6.1's Codex body for `messages` at `level`: the input `buildRequestBody` renders and its top-level effort. */
function render(messages: unknown[], level: string): Body {
	const { input, requestEffortBaseline } = shared.prepareResponsesPrompt(model, { systemPrompt: "You are a probe.", messages }, new Set([model.provider]), {
		configurationUpdateEffort: level,
		effortBaseline: "initial",
	});
	return { model: model.id, input, reasoning: { effort: requestEffortBaseline ?? level, summary: "auto" } };
}

const input = (body: Body) => body.input as unknown[];

/** Drives the ledger through a conversation: each request splices pi's tail rendering onto the last record, as the wire hook does. */
function conversation() {
	const messages: unknown[] = [];
	let record: ReturnType<typeof recordedRequest> | undefined;
	let covered = 0;
	const sent: Body[] = [];
	return {
		sent,
		/** One request at `level`; an aborted reply never reaches the context (pi drops it). */
		send(text: string, level: string, { aborted = false } = {}): Body {
			messages.push(user(text));
			const body = record ? spliceRequest(record, render(messages.slice(covered), level), api) : render(messages, level);
			record = recordedRequest(body, identity);
			covered = messages.length;
			if (!aborted) messages.push(reply(`${text} done`, level));
			sent.push(body);
			return body;
		},
		whole: (level: string) => render(messages.slice(0, covered), level),
	};
}

describe("the splice keeps Codex's effort items as pi renders the whole conversation", () => {
	it("equals pi's whole rendering at every request across level changes, and each request extends the one before", () => {
		const chat = conversation();
		// "none" is thinking off on Codex.
		const steps: [string, string][] = [["one", "high"], ["two", "high"], ["three", "medium"], ["four", "medium"], ["five", "high"], ["six", "high"], ["seven", "none"]];
		for (const [text, effort] of steps) expect(chat.send(text, effort)).toEqual(chat.whole(effort));
		for (let i = 1; i < chat.sent.length; i++) {
			const before = input(chat.sent[i - 1]);
			const prefix = before.slice(0, appendPoint(before, api));
			expect(input(chat.sent[i]).slice(0, prefix.length)).toEqual(prefix);
			expect(chat.sent[i].reasoning).toEqual(chat.sent[0].reasoning);
		}
	});

	// The record has no item yet: the session never changed its level before the abort.
	it("keeps the top level when a level change follows an aborted reply", () => {
		const chat = conversation();
		chat.send("one", "high");
		chat.send("two", "high", { aborted: true });
		const three = chat.send("three", "medium");
		expect(three).toEqual(chat.whole("medium"));
		expect(three.reasoning).toEqual(chat.sent[0].reasoning);
		expect(chat.send("four", "medium")).toEqual(chat.whole("medium"));
	});

	// Without the fix: request four went out at the top-level effort "medium" with no item, a full miss (findings §110).
	it("opens the tail with the new effort on the second request after a change", () => {
		const chat = conversation();
		chat.send("one", "high");
		chat.send("two", "high");
		chat.send("three", "medium");
		const four = chat.send("four", "medium");
		expect(four.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(input(four).filter((item) => (item as Body).type === "configuration_update")).toEqual([{ type: "configuration_update", reasoning: { effort: "medium" } }]);
	});
});

describe("withTailEffort leaves other shapes alone", () => {
	const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
	const u = { role: "user", content: "q" };
	const a = { type: "message", role: "assistant", content: [] };
	const head = (effort: string) => ({ reasoning: { effort } });

	it("changes nothing for a model without effort items (the level rides the top level)", () => {
		const tail = [a, u];
		expect(withTailEffort({ list: [u], end: 1, head: head("high"), effortItems: false }, head("low"), tail, api)).toBe(tail);
	});

	it("changes nothing on pi 1.6.0's tail: an item before every reply and at the end, under a fixed medium", () => {
		const tail = [update("high"), a, u, update("low")];
		expect(withTailEffort({ list: [u, update("high"), a, u, update("high")], end: 4, head: head("medium"), effortItems: true }, head("medium"), tail, api)).toBe(tail);
	});

	it("changes nothing outside the Responses APIs", () => {
		const tail = [a];
		expect(withTailEffort({ list: [update("high")], end: 1, head: head("high"), effortItems: true }, head("low"), tail, "openai-completions")).toBe(tail);
	});

	it("does not count a client-side tool load as a reply", () => {
		const load = { type: "tool_search_call", execution: "client", call_id: "c1", arguments: {} };
		const tail = [load, { type: "tool_search_output", call_id: "c1", tools: [] }, u, update("high")];
		expect(withTailEffort({ list: [u, update("high"), a], end: 3, head: head("medium"), effortItems: true }, head("medium"), tail, "openai-responses")).toBe(tail);
	});
});

describe("a cache warm after a /reload resends the record's top-level effort", () => {
	it("keeps the record's effort, not the tail's", async () => {
		const { recordedBody } = await import("../../extensions/lib/request/ledger/wire.ts");
		const chat = conversation();
		chat.send("one", "high");
		chat.send("two", "medium");
		const four = chat.send("three", "medium");
		const record = recordedRequest(four, identity);
		const warm = recordedBody(record, { ...render([reply("three done", "medium")], "medium"), max_output_tokens: 1 }, api);
		// The conversation started at high; the warm's own rendering starts at medium.
		expect(warm.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(four.reasoning).toEqual(warm.reasoning);
		expect(input(warm)).toEqual(input(four));
	});
});

describe("a fork thinking at another level than its parent", () => {
	it("keeps the parent's top level and opens its tail with its own effort", () => {
		const parent = conversation();
		parent.send("one", "high");
		parent.send("two", "medium");
		const capture = { api, provider: model.provider, modelId: model.id, payload: parent.sent[1] } as never;
		const child = render([user("fork task")], "low");
		const out = forkRequestPayload(capture, child, new Set(), true);
		expect(out.reasoning).toEqual(parent.sent[1].reasoning);
		const list = input(out);
		expect(list.slice(0, input(parent.sent[1]).length)).toEqual(input(parent.sent[1]));
		// The task has no reply yet, so the item ends the list, as pi places it.
		expect(list.slice(input(parent.sent[1]).length)).toEqual([...input(child), { type: "configuration_update", reasoning: { effort: "low" } }]);
	});
});

describe("a fork whose parent never changed its level", () => {
	it("opens its task with its own effort", () => {
		const parent = conversation();
		parent.send("one", "high");
		parent.send("two", "high");
		const capture = { api, provider: model.provider, modelId: model.id, payload: parent.sent[1] } as never;
		const out = forkRequestPayload(capture, render([user("fork task")], "low"), new Set(), true);
		expect(out.reasoning).toEqual(parent.sent[1].reasoning);
		expect(input(out).at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
	});
});
