import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseMark, lastMessageMark, withPreviousMark } from "../../extensions/lib/previous-mark.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../../extensions/lib/ledger/plan.ts";
import cacheMarksExtension from "../../extensions/cache-marks/index.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const mark = { type: "ephemeral", ttl: "1h" };
const text = (t: string, marked = false) => ({ type: "text", text: t, ...(marked ? { cache_control: mark } : {}) });
const facts = (marked: boolean) => ({ role: "system", content: [text("session facts", marked)] });
const first = { role: "user", content: [text("first prompt")] };
const additions = { role: "system", content: [text("tools became available"), { type: "tool_addition", tool: { type: "tool_reference", name: "x" } }] };
const tail = (marked: boolean) => ({ role: "system", content: [text("<total_tokens>", marked)] });

/** pi's shape: one mark on the tools, one on the system, one on the conversation tail. */
const request = (messages: unknown[]) => ({
	model: "claude-sonnet-5-5",
	max_tokens: 100,
	tools: [{ name: "bash", cache_control: mark }],
	system: [text("system prompt", true)],
	messages,
});

describe("previous-mark", () => {
	const one = request([first, facts(true)]);
	const previous = lastMessageMark(one.messages);

	it("finds the request's last conversation breakpoint", () => {
		expect(previous).toEqual({ message: 1, block: 0, marker: mark, content: text("session facts", true) });
		expect(lastMessageMark([first])).toBeUndefined();
	});

	it("marks the previous request's breakpoint block again when the tail moved past it", () => {
		const two = request([first, facts(false), additions, tail(true)]);
		const next = withPreviousMark(two, previous);
		expect((next.messages as Array<{ content: unknown[] }>)[1].content[0]).toEqual(text("session facts", true));
		expect((next.messages as Array<{ content: unknown[] }>)[3].content[0]).toEqual(text("<total_tokens>", true));
		expect(two.messages[1]).toEqual(facts(false)); // never mutates its input
	});

	it("leaves the request alone when the block changed, is still marked, or no slot is free", () => {
		const changed = request([first, { role: "system", content: [text("other facts")] }, tail(true)]);
		expect(withPreviousMark(changed, previous)).toBe(changed);
		const same = request([first, facts(true)]);
		expect(withPreviousMark(same, previous)).toBe(same);
		const full = { ...request([first, facts(false), { role: "user", content: [text("a", true)] }, tail(true)]) };
		expect(withPreviousMark(full, previous)).toBe(full);
		expect(withPreviousMark(one, undefined)).toBe(one);
	});
});

describe("baseMark", () => {
	it("is the base's last block before its trailing directive, with the request's own tail marker", () => {
		const directive = { role: "system", content: [], output_config: { effort: "high" } };
		const spliced = [first, facts(false), directive, additions, tail(true)];
		expect(baseMark(spliced, [first, facts(false), directive], "anthropic-messages")).toEqual({ message: 1, block: 0, marker: mark, content: text("session facts") });
		expect(baseMark(spliced, [], "anthropic-messages")).toBeUndefined();
		expect(baseMark([first, facts(false)], [first, facts(false)], "anthropic-messages")).toBeUndefined();
	});
});

describe("cache-marks wiring", () => {
	// On, whatever the environment running the tests says.
	beforeEach(() => vi.stubEnv("CC_CACHE_MARKS", ""));
	afterEach(() => vi.unstubAllEnvs());
	const anthropic = { model: { provider: "anthropic", api: "anthropic-messages" } };
	/** The ledger's plan for a request that extends a base whose list was `list`. */
	const extending = (list: unknown[]) => ({ epoch: false, base: { list } }) as unknown as RequestPlan;

	it("marks the block the base request carried its tail mark on, on first-party Anthropic only", async () => {
		const fake = createFakePi();
		cacheMarksExtension(fake.pi as never);
		fake.events.emit(LEDGER_PLAN_CHANNEL, extending([first, facts(false)]));
		const next = await fake.fireOne<{ messages: Array<{ content: unknown[] }> }>("before_provider_request", { payload: request([first, facts(false), additions, tail(true)]) }, anthropic);
		expect(next?.messages[1].content[0]).toEqual(text("session facts", true));

		const other = createFakePi();
		cacheMarksExtension(other.pi as never);
		other.events.emit(LEDGER_PLAN_CHANNEL, extending([first, facts(false)]));
		const openrouter = { model: { provider: "openrouter", api: "anthropic-messages" } };
		expect(await other.fireOne("before_provider_request", { payload: request([first, facts(false), additions, tail(true)]) }, openrouter)).toBeUndefined();
	});

	it("leaves a proxy endpoint alone", async () => {
		const fake = createFakePi();
		cacheMarksExtension(fake.pi as never);
		fake.events.emit(LEDGER_PLAN_CHANNEL, extending([first, facts(false)]));
		const proxy = { model: { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://proxy.example.com" } };
		expect(await fake.fireOne("before_provider_request", { payload: request([first, facts(false), additions, tail(true)]) }, proxy)).toBeUndefined();
	});

	it("adds nothing to a request that opens an epoch", async () => {
		const fake = createFakePi();
		cacheMarksExtension(fake.pi as never);
		fake.events.emit(LEDGER_PLAN_CHANNEL, { epoch: true } as RequestPlan);
		expect(await fake.fireOne("before_provider_request", { payload: request([first, facts(false), additions, tail(true)]) }, anthropic)).toBeUndefined();
	});
});
