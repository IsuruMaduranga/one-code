import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFER_CHANNEL, deferredAddendumText, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import webExtension from "../../extensions/web/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import type { Reminder } from "./helpers/tool-search-fake-pi.ts";

const gemini = { provider: "google", api: "google-generative-ai", id: "gemini-test" };
const other = { provider: "openai", api: "openai-responses", id: "gpt-test" };
type Model = typeof gemini | undefined;
type SearchResult = { content: Array<{ text: string }>; details: { matches: string[] }; isError?: boolean };

/** Drive both real extensions, including pi-web-search's active-tool manager. */
function harness() {
	const fake = createFakePi();
	fake.pi.getAllTools = () => [...fake.tools.values()];
	const reminders: Reminder[] = [];
	const transitions: Array<{ channel: string; name: string }> = [];
	fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as Reminder));
	for (const channel of [DEFER_CHANNEL, WITHHOLD_CHANNEL]) {
		fake.events.on(channel, (data) => transitions.push({ channel, name: (data as { name: string }).name }));
	}
	toolSearchExtension(fake.pi as never);
	webExtension(fake.pi as never);
	fake.setActiveTools(["read", ...fake.tools.keys()]);
	const ctx = (model: Model) => createFakeCtx({ model });
	let call = 0;
	const search = (query = "select:url_context") =>
		fake.tools.get("tool_search")!.execute(`search-${++call}`, { query }, undefined, undefined, ctx(other)) as Promise<SearchResult>;
	return {
		...fake,
		reminders,
		transitions,
		search,
		async start(model: Model) {
			await fake.fire("session_start", {}, ctx(model));
			fake.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
			await vi.advanceTimersByTimeAsync(150);
		},
		async switchModel(event: string, model: Model) {
			await fake.fire(event, { model }, ctx(model));
			await vi.advanceTimersByTimeAsync(150);
		},
		request: (model: Model) => fake.fire("context", { messages: [] }, ctx(model)),
	};
}

const listings = (reminders: Reminder[]) => reminders.filter((r) => r.key === "deferred-tools");

describe("url_context model-scoped deferral", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	for (const event of ["model_select", "session_tree"]) {
		it(`${event}: withdraws a Gemini tool from search without rewriting the cached listing`, async () => {
			const fake = harness();
			await fake.start(gemini);
			expect(listings(fake.reminders).at(-1)?.text).toContain("url_context");
			expect(fake.getActiveTools()).not.toContain("url_context");
			await fake.request(gemini);
			const frozen = structuredClone(listings(fake.reminders));

			await fake.switchModel(event, other);
			const result = await fake.search();
			expect(result.isError).toBe(true);
			expect(result.details.matches).toEqual([]);
			expect(result.content[0].text).toContain("Withdrawn for the current model (do not retry): url_context.");
			expect((await fake.search("gemini")).details.matches).not.toContain("url_context");
			expect(fake.getActiveTools()).not.toContain("url_context");
			expect(listings(fake.reminders)).toEqual(frozen);
		});

		it(`${event}: announces Gemini as a late arrival when starting elsewhere`, async () => {
			const fake = harness();
			await fake.start(other);
			expect(listings(fake.reminders).at(-1)?.text).not.toContain("url_context");
			expect((await fake.search()).details.matches).toEqual([]);
			await fake.request(other);
			const frozen = structuredClone(listings(fake.reminders));

			await fake.switchModel(event, gemini);
			expect(fake.getActiveTools()).not.toContain("url_context");
			expect(fake.reminders.filter((r) => r.text === deferredAddendumText(["url_context"]))).toHaveLength(1);
			expect(listings(fake.reminders)).toEqual(frozen);
			expect((await fake.search()).details.matches).toEqual(["url_context"]);
			expect(fake.getActiveTools()).toContain("url_context");
		});

		it(`${event}: withdraws an already loaded tool and explains a direct-call miss`, async () => {
			const fake = harness();
			await fake.start(gemini);
			await fake.search();
			expect(fake.getActiveTools()).toContain("url_context");
			await fake.request(gemini);

			await fake.switchModel(event, other);
			expect(fake.getActiveTools()).not.toContain("url_context");
			await fake.fire("tool_execution_end", {
				isError: true,
				result: { content: [{ type: "text", text: "Tool url_context not found" }] },
			});
			const miss = fake.reminders.find((r) => r.key === "deferred-miss-url_context");
			expect(miss?.text).toContain("withdrawn for the current model");
			expect(miss?.text).not.toContain("select:url_context");
			expect((await fake.search()).isError).toBe(true);
			expect(fake.getActiveTools()).not.toContain("url_context");
		});

		it(`${event}: re-defers on every return to Gemini and preserves loads on same-provider events`, async () => {
			const fake = harness();
			await fake.start(other);
			await fake.request(other);
			for (let cycle = 0; cycle < 3; cycle++) {
				await fake.switchModel(event, gemini);
				expect(fake.getActiveTools()).not.toContain("url_context");
				expect((await fake.search()).details.matches).toEqual(["url_context"]);
				await fake.switchModel(event, { ...gemini, id: `gemini-${cycle}` });
				expect(fake.getActiveTools()).toContain("url_context");
				await fake.switchModel(event, other);
				expect((await fake.search()).isError).toBe(true);
				expect(fake.getActiveTools()).not.toContain("url_context");
			}
			expect(fake.transitions.filter((t) => t.name === "url_context" && t.channel === DEFER_CHANNEL)).toHaveLength(3);
			expect(fake.transitions.filter((t) => t.name === "url_context" && t.channel === WITHHOLD_CHANNEL)).toHaveLength(3);
		});
	}

	it("handles an unresolved model at startup and withdraws when the model becomes unresolved", async () => {
		const fake = harness();
		await fake.start(undefined);
		expect((await fake.search()).isError).toBe(true);
		await fake.switchModel("model_select", gemini);
		expect((await fake.search()).details.matches).toEqual(["url_context"]);
		await fake.switchModel("session_tree", undefined);
		expect((await fake.search()).isError).toBe(true);
		expect(fake.getActiveTools()).not.toContain("url_context");
	});

	it("matches the vendor's provider-based Gemini gate as well as its API-based gate", async () => {
		const fake = harness();
		await fake.start({ provider: "google-generative-ai", api: "custom", id: "gemini-custom" });
		expect((await fake.search()).details.matches).toEqual(["url_context"]);
		await fake.switchModel("model_select", other);
		expect((await fake.search()).isError).toBe(true);
	});

	it("withdraws before the first request without leaving the tool in the initial listing", async () => {
		const fake = harness();
		await fake.start(gemini);
		await fake.switchModel("model_select", other);
		expect(listings(fake.reminders).at(-1)?.text).not.toContain("url_context");
		expect((await fake.search()).isError).toBe(true);
	});
});
