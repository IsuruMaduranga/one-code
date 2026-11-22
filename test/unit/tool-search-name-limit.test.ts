import { beforeEach, describe, expect, it } from "vitest";
import toolSearchExtension from "../../extensions/request/tool-search/index.ts";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

/**
 * A deferred tool whose name is over the current model's provider limit (an
 * MCP tool between 65 and 128 characters on the OpenAI family) is withdrawn
 * while that model runs: not active, not listed, not loadable. A switch back
 * to a model that takes it restores it. The limit changes only with the
 * model, and a model switch opens a ledger epoch, so the tools array changes
 * at that switch and nowhere inside an epoch.
 */
const LONG = "mcp__github__list_pull_request_review_comments_for_repository_branch"; // 69 characters
const anthropic = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5-5" };
const openai = { provider: "openai", api: "openai-responses", id: "gpt-6" };
const listings = (reminders: Reminder[]) => reminders.filter((r) => r.key === "deferred-tools");

const loadEntry = (toolCallId: string, added: string[]) => ({
	type: "message",
	message: { role: "toolResult", toolName: "tool_search", toolCallId, details: { added, matches: added, notFound: [] } },
});

describe("tool-search and the provider's tool-name limit", () => {
	let fake: ReturnType<typeof makeToolSearchFakePi>;
	/** The branch: the transcript loaded the long tool through tool_search. */
	const session = { getBranch: () => [loadEntry("toolu_1", [LONG])] };
	const ctx = (model: object) => ({ sessionManager: session, model });
	beforeEach(() => {
		fake = makeToolSearchFakePi();
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("web_fetch");
		fake.addDeferred(LONG);
		fake.pi.fire("session_start", {}, ctx(anthropic));
	});

	it("keeps a loaded tool active on a model that takes its name", () => {
		fake.pi.fire("turn_start", {}, ctx(anthropic));
		expect(fake.activeTools()).toEqual([LONG]);
		expect(listings(fake.reminders).at(-1)?.text).toContain(LONG);
	});

	it("withdraws a loaded tool when the model switches to a provider that refuses its name, and restores it on the switch back", () => {
		expect(fake.activeTools()).toEqual([LONG]);

		fake.pi.fire("model_select", { model: openai });
		expect(fake.activeTools()).toEqual([]);
		fake.pi.fire("turn_start", {}, ctx(openai));
		expect(fake.activeTools()).toEqual([]);
		const onOpenai = listings(fake.reminders).at(-1)?.text ?? "";
		expect(onOpenai).toContain("web_fetch");
		expect(onOpenai).not.toContain(LONG);

		fake.pi.fire("model_select", { model: anthropic });
		expect(fake.activeTools()).toEqual([LONG]);
		fake.pi.fire("turn_start", {}, ctx(anthropic));
		expect(fake.activeTools()).toEqual([LONG]);
		expect(listings(fake.reminders).at(-1)?.text).toContain(LONG);
	});

	it("does not load the tool on such a model, and calls it withdrawn rather than misspelled", async () => {
		fake.pi.fire("model_select", { model: openai });
		const result = await fake.runTool("tool_search", { query: `select:${LONG},web_fetch` });
		expect(result.content[0]?.text).toBe(toolSearchResultText.result({ added: ["web_fetch"], already: [], refused: [], missing: [], withdrawn: [LONG] }));
		expect(fake.activeTools()).toEqual(["web_fetch"]);
	});

	it("steers a direct call on such a model as a withdrawn tool, not to tool_search", () => {
		fake.pi.fire("model_select", { model: openai });
		fake.reminders.length = 0;
		fake.pi.fire("tool_execution_end", { isError: true, result: { content: [{ type: "text", text: `Tool ${LONG} not found` }] } });
		expect(fake.reminders.find((r) => r.key === `deferred-miss-${LONG}`)?.text).toBe(toolSearchResultText.withheldMiss({ name: LONG }));
	});

	it("never announces the tool as removed inside an epoch that told it", () => {
		fake.pi.fire("model_select", { model: openai });
		fake.pi.fire("turn_start", {}, ctx(openai));
		expect(fake.render({ told: { tools: ["web_fetch", LONG] }, model: openai as never })).toEqual([]);
	});
});
