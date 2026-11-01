/**
 * The ledger on both Responses tool shapes: pi 1.0 to 1.3 declare a request's
 * tools in a top-level `tools` array; pi 1.4.0 declares them, for models
 * flagged for mid-conversation system messages and additional tools, in an
 * `additional_tools` item at the head of the input (findings §78). The
 * elements come from a real pi 1.4.0 request (fixtures/responses-pi-1.4.0.json).
 */
import { describe, expect, it } from "vitest";
import { preludeLength, recordedBody, recordedRequest, recordedToolNames, spliceRequest, withBranchToolOrder } from "../../extensions/lib/ledger/wire.ts";
import { declaredNames as declarations, type Item, real, toolsItem } from "./helpers/responses-fixture.ts";

const api = "openai-responses";
const codex = "openai-codex-responses";
const identity = { api, provider: "openai", model: "gpt-6.1-sol", auth: "key" };
const { body, headItem, prompt, userStack, environment, configuration, loadCall, loadOutput, budget, webFetch } = real;
const startingTools = headItem.tools;

const recorded = (payload: Item, at = api) => recordedRequest(payload, { ...identity, api: at });
const input = (payload: Item) => payload.input as Item[];
const prompts = (payload: Item) => input(payload).filter((item) => JSON.stringify(item) === JSON.stringify(prompt)).length;

/** Request 1 on pi 1.4.0, as recorded: the head item, the prompt, the first-message stack. */
const request1 = { ...body, input: [headItem, prompt, userStack, environment, configuration] };
/** pi 1.4.0's rendering of request 2's tail inside the epoch: its head again (now holding the loaded tool), then what came after request 1. */
const tail2 = (tools = [...startingTools, webFetch]) => ({ ...body, input: [toolsItem(tools), prompt, configuration, loadCall, loadOutput, budget, configuration] });

describe("preludeLength on both Responses shapes", () => {
	it("strips pi 1.4.0's leading tools item and the prompt after it", () => {
		expect(preludeLength([headItem, prompt, userStack], api)).toBe(2);
		expect(preludeLength([headItem, userStack], codex)).toBe(1);
	});

	it("keeps pi 1.3.0's prompt-only prelude", () => {
		expect(preludeLength([prompt, userStack], api)).toBe(1);
		expect(preludeLength([userStack], codex)).toBe(0);
	});

	it("leaves an element it does not recognize in the tail", () => {
		expect(preludeLength([{ type: "tools_update", tools: [] }, prompt], api)).toBe(0);
		// A typed developer item is not the prompt.
		expect(preludeLength([{ type: "reasoning_note", role: "developer", content: "x" }], api)).toBe(0);
	});
});

describe("spliceRequest on a pi 1.4.0 record", () => {
	const base = recorded(request1);

	it("keeps the recorded head item, sends the prompt once and declares a tool pi added once, after the cached prefix", () => {
		const out = spliceRequest(base, tail2(), api);
		const list = input(out);
		expect(list[0]).toEqual(headItem);
		expect(prompts(out)).toBe(1);
		expect(out.tools).toBeUndefined();
		// The recorded list up to its append point (the trailing configuration_update dropped), then the new declaration.
		expect(list.slice(0, 4)).toEqual([headItem, prompt, userStack, environment]);
		expect(list[4]).toEqual(toolsItem([webFetch]));
		expect(declarations(out).filter((name) => name === "web_fetch")).toHaveLength(1);
	});

	it("adds nothing when the tail already declares the loaded tool (tool-search placed it at its load)", () => {
		const placed = tail2(startingTools);
		input(placed).splice(4, 0, toolsItem([webFetch]));
		const out = spliceRequest(base, placed, api);
		expect(input(out).filter((item) => item.type === "additional_tools")).toHaveLength(2);
		expect(declarations(out).filter((name) => name === "web_fetch")).toHaveLength(1);
	});

	it("adds nothing on the next request, whose record declares the tool", () => {
		const second = recordedRequest(spliceRequest(base, tail2(), api), identity);
		const tail3 = { ...body, input: [toolsItem([...startingTools, webFetch]), prompt, { type: "message", role: "assistant", content: [] }] };
		const out = spliceRequest(second, tail3, api);
		expect(declarations(out).filter((name) => name === "web_fetch")).toHaveLength(1);
		// The second record up to its append point (its trailing configuration_update dropped), then only the new assistant turn.
		expect(second.list.at(-1)).toEqual(configuration);
		expect(input(out)).toEqual([...second.list.slice(0, -1), input(tail3).at(-1)]);
	});

	it("declares a tool again when its input schema changed", () => {
		const changed = startingTools.map((tool) => (tool.name === "read" ? { ...tool, parameters: { type: "object", properties: { path: { type: "string" } } } } : tool));
		const out = spliceRequest(base, tail2(changed), api);
		const added = input(out)[4] as Item & { tools: Item[] };
		expect(added.tools.map((tool) => tool.name)).toEqual(["read"]);
	});

	it("never adds a top-level tools array, even when pi renders one (a 1.3.0 pi on a 1.4.0 record)", () => {
		const live = { ...body, tools: [...startingTools, webFetch], input: [prompt, configuration, loadCall, loadOutput] };
		const out = spliceRequest(base, live, api);
		expect(out.tools).toBeUndefined();
		expect(input(out)[0]).toEqual(headItem);
		expect(declarations(out).filter((name) => name === "web_fetch")).toHaveLength(1);
	});

	it("re-sends a pi 1.4.0 record without a top-level tools array (a cache warm)", () => {
		const out = recordedBody(base, { ...body, tools: startingTools, input: [], max_output_tokens: 16 }, api);
		expect(out.tools).toBeUndefined();
		expect(input(out)[0]).toEqual(headItem);
	});
});

describe("spliceRequest on a pi 1.3.0 record continued under pi 1.4.0", () => {
	const base = recorded({ ...body, tools: startingTools, input: [prompt, userStack, environment, configuration] });

	it("keeps the recorded top-level tools, sends the prompt once and appends a new tool there", () => {
		const out = spliceRequest(base, tail2(), api);
		expect((out.tools as Item[]).map((tool) => tool.name)).toEqual([...startingTools.map((tool) => tool.name), "web_fetch"]);
		expect(input(out).some((item) => item.type === "additional_tools")).toBe(false);
		expect(prompts(out)).toBe(1);
		expect(input(out).slice(0, 3)).toEqual([prompt, userStack, environment]);
	});
});

describe("spliceRequest on Codex under pi 1.4.0", () => {
	it("does not repeat the head item on every request", () => {
		const base = recorded({ ...body, instructions: "p", input: [headItem, userStack] }, codex);
		const out = spliceRequest(base, { ...body, instructions: "p", input: [headItem, loadCall, loadOutput] }, codex);
		expect(input(out).filter((item) => item.type === "additional_tools")).toHaveLength(1);
		expect(input(out)).toEqual([headItem, userStack, loadCall, loadOutput]);
	});
});

describe("recordedToolNames", () => {
	it("reads a pi 1.4.0 record's head item and a pi 1.3.0 record's top-level tools alike", () => {
		const names = startingTools.map((tool) => tool.name);
		expect([...recordedToolNames(recorded(request1))]).toEqual(names);
		expect([...recordedToolNames(recorded({ ...body, tools: startingTools, input: [prompt] }))]).toEqual(names);
	});
});

describe("withBranchToolOrder on a leading tools item", () => {
	it("orders the item's tools like the branch, keeping their bytes", () => {
		const reversed = [...startingTools].reverse();
		const out = withBranchToolOrder({ ...body, input: [toolsItem(reversed), prompt] }, startingTools.map((tool) => String(tool.name)), api);
		expect(input(out)[0]).toEqual(headItem);
	});
});
