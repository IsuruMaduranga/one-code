/**
 * /context before the first request estimates the request the next prompt
 * will send, from the parts that build it. Each part is read through a query
 * that must keep, record and tell nothing, or /context would change the
 * request it estimates.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import systemPromptExtension from "../../extensions/request/system-prompt/index.ts";
import systemReminderExtension from "../../extensions/request/system-reminder/index.ts";
import { requestSystemPrompt } from "../../extensions/lib/ui/prompt-options.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, renderReminders, STACK_QUERY_CHANNEL, type StackQuery } from "../../extensions/lib/request/reminders.ts";
import { BLOCK_HEADS, breakdownRequest, contextUsage, previewRequest } from "../../extensions/lib/context/context-usage.ts";
import { renderContextUsage } from "../../extensions/lib/ui/context-usage-view.ts";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("the system prompt before the first prompt", () => {
	const setup = async () => {
		const fake = createFakePi();
		systemPromptExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: mkdtempSync(join(tmpdir(), "context-preview-")), model: { id: "claude-sonnet-5", provider: "anthropic" }, sessionManager: { getSessionId: () => "s" } });
		fake.setActiveTools(["read", "bash"]);
		await fake.fire("session_start", { type: "session_start" }, ctx);
		return { fake, ctx };
	};

	it("is the prompt the first typed turn then gets, and keeps nothing", async () => {
		const { fake, ctx } = await setup();
		const options = { cwd: ctx.cwd, selectedTools: ["read", "bash"], toolSnippets: { read: "Read a file", bash: "Run a command" } };
		const dry = requestSystemPrompt(fake.events, ctx, options);
		// The dry build stored no options: a fork's request (no options) still has nothing to build from.
		expect(requestSystemPrompt(fake.events, ctx)).toBeUndefined();
		const typed = await fake.fireOne<{ systemPrompt: string }>("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, ctx);
		expect(dry).toBe(typed?.systemPrompt);
	});

	it("adds the environment block and model line turn_start will queue, without queueing them", async () => {
		const { fake, ctx } = await setup();
		const queued: Array<{ key?: string; text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => queued.push(data as { key?: string; text?: string }));
		const query: StackQuery = { ctx, stack: [] };
		fake.events.emit(STACK_QUERY_CHANNEL, query);
		expect(queued).toEqual([]);
		await fake.fire("turn_start", { type: "turn_start" }, ctx);
		const real = new Map(queued.map((payload) => [payload.key, payload.text]));
		expect(query.stack?.map((entry) => [entry.key, entry.text])).toEqual([
			["environment", real.get("environment")],
			["model-line", real.get("model-line")],
		]);
		// Once queued, the live stack has them and the query adds nothing.
		const after: StackQuery = { ctx, stack: [{ key: "environment", text: "x", order: 1 }] };
		fake.events.emit(STACK_QUERY_CHANNEL, after);
		expect(after.stack).toHaveLength(1);
	});

	it("adds no environment block or model line before a custom prompt's first turn, as that turn adds none", async () => {
		const { fake, ctx } = await setup();
		const options = { cwd: ctx.cwd, customPrompt: "You are a reviewer." };
		const query: StackQuery = { ctx: { ...ctx, getSystemPromptOptions: () => options }, stack: [] };
		fake.events.emit(STACK_QUERY_CHANNEL, query);
		expect(query.stack).toEqual([]);
		const queued: Array<{ key?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => queued.push(data as { key?: string }));
		await fake.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, ctx);
		await fake.fire("turn_start", { type: "turn_start" }, ctx);
		expect(queued.some((payload) => payload.key === "environment" || payload.key === "model-line")).toBe(false);
	});

	it("leaves pi's options alone once a prompt has run", async () => {
		const { fake, ctx } = await setup();
		const options = { cwd: ctx.cwd, selectedTools: ["read"] };
		await fake.fireOne<{ systemPrompt: string }>("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, ctx);
		// The same answer with and without passed options: a custom prompt among them would otherwise answer nothing.
		const kept = requestSystemPrompt(fake.events, ctx);
		expect(kept).toEqual(expect.any(String));
		expect(requestSystemPrompt(fake.events, ctx, { cwd: ctx.cwd, customPrompt: "Other" })).toBe(kept);
	});
});

describe("the stack query", () => {
	it("returns the live stack and records nothing, and the next request renders the same", async () => {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => fake.branch } });
		await fake.fire("session_start", { type: "session_start" }, ctx);
		fake.events.emit(REMINDER_CHANNEL, { text: "Skills listing", key: "skills", placement: "first-prepend", order: CONTEXT_ORDER.skills });
		fake.events.emit(REMINDER_CHANNEL, { text: "Environment", key: "environment", placement: "first-prepend", order: CONTEXT_ORDER.environment });
		const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
		const entriesBefore = fake.appendedEntries.length;
		const query: StackQuery = {};
		fake.events.emit(STACK_QUERY_CHANNEL, query);
		expect(query.stack?.map((entry) => entry.text)).toEqual(["Environment", "Skills listing"]);
		expect(fake.appendedEntries).toHaveLength(entriesBefore);
		// The real renderer places the queried stack as the request's own pass does.
		const own = await fake.fireOne<{ messages: unknown[] }>("context", { type: "context", messages }, ctx);
		const dry = renderReminders(messages as never, { epoch: true, layout: false, stack: query.stack ?? [], sticky: [], oneShots: [] });
		expect(dry.messages).toEqual(own?.messages);
	});
});

describe("previewRequest", () => {
	it("counts the system prompt, the up-front tools and the stack, lists deferred MCP tools, and has no messages", () => {
		const stack = [
			`<system-reminder>\n${toolSearchResultText.listingHead}\nweb_fetch: read a page\nmcp__docs__search\n</system-reminder>`,
			`<system-reminder>\n${BLOCK_HEADS.skills}\n\n- simplify: Review the changed code.\n</system-reminder>`,
			"<system-reminder>\n# Environment\nPrimary working directory: /p\n</system-reminder>",
		];
		const view = previewRequest({
			systemPrompt: "You are One Code.",
			tools: [
				{ name: "read", description: "Read a file", parameters: { type: "object" } },
				{ name: "mcp__docs__fetch", description: "Fetch", parameters: { type: "object" } },
			],
			deferred: ["web_fetch", "mcp__docs__search"],
			list: [{ role: "user", content: [...stack.map((text) => ({ type: "text", text })), { type: "text", text: "" }] }],
		});
		const breakdown = breakdownRequest(view);
		expect(breakdown.tokens.messages).toBe(0);
		expect(breakdown.mcpLoaded.map((item) => item.name)).toEqual(["mcp__docs__fetch"]);
		expect(breakdown.mcpAvailable).toEqual(["mcp__docs__search"]);
		expect(breakdown.skills.map((item) => item.name)).toEqual(["simplify"]);
		const usage = contextUsage({ model: { name: "M", id: "m" }, window: 1_000_000, breakdown, preview: "first" });
		expect(usage.categories.map((row) => row.name)).toEqual(["System prompt", "System tools", "MCP tools", "Skills"]);
		expect(usage.total).toBe(usage.categories.reduce((sum, row) => sum + row.tokens, 0));
		const text = renderContextUsage(usage, { width: 100 }).join("\n");
		expect(text).toMatch(/\d+(\.\d)?k?\/1m tokens \(\d+%\)/);
		expect(text).toContain("Estimated from what the next request will send: nothing sent yet.");
		expect(text).not.toContain("Messages");
	});
});
