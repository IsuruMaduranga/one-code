/**
 * A turn an extension opens from idle (a cron or /loop tick, a background
 * completion) skips before_agent_start, so pi built its default prompt for it
 * (findings §27). The context_with_system handler must install the exact
 * prompt a typed turn gets, or every tick loses One Code's instructions and
 * the first one rewrites the prompt cache.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import systemPromptExtension from "../../extensions/system-prompt/index.ts";
import { optionsForIdleTurn, withSystemHead } from "../../extensions/system-prompt/idle-turn.ts";
import { announcePromptOptions, requestSystemPrompt } from "../../extensions/lib/prompt-options.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const PI_DEFAULT = "You are an expert coding assistant operating inside pi, a coding agent harness.";

describe("optionsForIdleTurn", () => {
	it("keeps the old tool order when the live set is the same", () => {
		const last = { cwd: "/p", selectedTools: ["read", "bash", "edit"] };
		expect(optionsForIdleTurn(last, ["edit", "read", "bash"])).toBe(last);
	});

	it("lists the live tools when the set changed", () => {
		const last = { cwd: "/p", selectedTools: ["read", "bash", "edit"] };
		expect(optionsForIdleTurn(last, ["read", "bash"]).selectedTools).toEqual(["read", "bash"]);
		expect(optionsForIdleTurn(last, ["read", "bash", "edit", "write"]).selectedTools).toEqual(["read", "bash", "edit", "write"]);
	});
});

describe("withSystemHead", () => {
	it("collapses every system message into one head with the prompt, keeping tools and timestamp", () => {
		const messages = [
			{ role: "system", content: PI_DEFAULT, timestamp: 5 },
			{ role: "user", content: "hi", timestamp: 6 },
			{ role: "system", content: "", timestamp: 7 },
			{ role: "assistant", content: "ok", timestamp: 8 },
		];
		const tools = [{ name: "read" }];
		const out = withSystemHead(messages, "OURS", { toolsAdded: tools, timestamp: 5 });
		expect(out).toEqual([
			{ role: "system", content: "OURS", toolsAdded: tools, timestamp: 5 },
			{ role: "user", content: "hi", timestamp: 6 },
			{ role: "assistant", content: "ok", timestamp: 8 },
		]);
	});
});

describe("system-prompt on a turn opened from idle", () => {
	const setup = () => {
		const fake = createFakePi();
		systemPromptExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd: mkdtempSync(join(tmpdir(), "idle-turn-")),
			model: { id: "claude-sonnet-5", provider: "anthropic" },
			sessionManager: { getSessionId: () => "session-1" },
		});
		return { fake, ctx };
	};
	const idleContext = () => ({
		type: "context_with_system",
		messages: [
			{ role: "system", content: PI_DEFAULT, toolsAdded: [{ name: "read" }], timestamp: 1 },
			{ role: "custom", customType: "one-code:cron-fire", content: [], timestamp: 2 },
		],
	});

	it("sends the prompt the last typed turn got, byte for byte", async () => {
		const { fake, ctx } = setup();
		fake.setActiveTools(["read", "bash"]);
		await fake.fire("session_start", { type: "session_start" }, ctx);
		const options = { cwd: ctx.cwd, selectedTools: ["read", "bash"], toolSnippets: { read: "Read a file", bash: "Run a command" } };
		const typed = await fake.fireOne<{ systemPrompt: string }>("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, ctx);
		// pi mutates the shared options object after the handlers return.
		Object.assign(options, { forceSystemPrompt: typed?.systemPrompt, selectedTools: ["bash", "read", "bash"] });

		const result = await fake.fireOne<{ messages: Array<Record<string, unknown>> }>("context_with_system", idleContext(), ctx);
		expect(typed?.systemPrompt).toContain("You are One Code");
		expect(result?.messages[0]).toEqual({ role: "system", content: typed?.systemPrompt, toolsAdded: [{ name: "read" }], timestamp: 1 });
		expect(result?.messages.slice(1)).toEqual(idleContext().messages.slice(1));
	});

	it("leaves a named agent's own prompt alone", async () => {
		const { fake, ctx } = setup();
		await fake.fire("session_start", { type: "session_start" }, ctx);
		await fake.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { cwd: ctx.cwd, customPrompt: "Agent prompt" } }, ctx);
		expect(await fake.fireOne("context_with_system", idleContext(), ctx)).toBeUndefined();
	});

	it("forgets the last session's options when a new session starts", async () => {
		const { fake, ctx } = setup();
		await fake.fire("session_start", { type: "session_start" }, ctx);
		await fake.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { cwd: ctx.cwd, customPrompt: "Agent prompt" } }, ctx);
		await fake.fire("session_start", { type: "session_start" }, ctx);
		await fake.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { cwd: ctx.cwd } }, ctx);
		const result = await fake.fireOne<{ messages: Array<Record<string, unknown>> }>("context_with_system", idleContext(), ctx);
		expect(String(result?.messages[0].content)).toContain("You are One Code");
		await fake.fire("session_start", { type: "session_start" }, ctx);
		expect(await fake.fireOne("context_with_system", idleContext(), ctx)).toBeUndefined();
	});

	it("does nothing before any typed turn has run", async () => {
		const { fake, ctx } = setup();
		await fake.fire("session_start", { type: "session_start" }, ctx);
		expect(await fake.fireOne("context_with_system", idleContext(), ctx)).toBeUndefined();
	});

	it("builds from a command's announced options before any typed turn, and a typed turn's options win", async () => {
		const { fake, ctx } = setup();
		fake.setActiveTools(["read", "bash"]);
		await fake.fire("session_start", { type: "session_start" }, ctx);
		const options = { cwd: ctx.cwd, selectedTools: ["read", "bash"], toolSnippets: { read: "Read a file", bash: "Run a command" } };
		announcePromptOptions(fake.events, { cwd: ctx.cwd, getSystemPromptOptions: () => options });
		const idle = await fake.fireOne<{ messages: Array<Record<string, unknown>> }>("context_with_system", idleContext(), ctx);
		const typed = await fake.fireOne<{ systemPrompt: string }>("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, ctx);
		expect(idle?.messages[0].content).toBe(typed?.systemPrompt);
		// A later announcement does not replace the typed turn's options.
		announcePromptOptions(fake.events, { cwd: ctx.cwd, getSystemPromptOptions: () => ({ cwd: ctx.cwd, customPrompt: "Other" }) });
		const later = await fake.fireOne<{ messages: Array<Record<string, unknown>> }>("context_with_system", idleContext(), ctx);
		expect(later?.messages[0].content).toBe(typed?.systemPrompt);
	});

	it("answers a fork's request with the prompt the next request carries, never pi's own", async () => {
		const { fake, ctx } = setup();
		await fake.fire("session_start", { type: "session_start" }, ctx);
		expect(requestSystemPrompt(fake.events, ctx)).toBeUndefined();
		const options = { cwd: ctx.cwd, selectedTools: ["read"] };
		announcePromptOptions(fake.events, { cwd: ctx.cwd, getSystemPromptOptions: () => options });
		const forked = requestSystemPrompt(fake.events, ctx);
		expect(forked).toContain("You are One Code");
		expect(forked).not.toContain(PI_DEFAULT);
		const idle = await fake.fireOne<{ messages: Array<Record<string, unknown>> }>("context_with_system", idleContext(), ctx);
		expect(idle?.messages[0].content).toBe(forked);
	});

	it("leaves a named agent's fork on pi's prompt (no answer)", async () => {
		const { fake, ctx } = setup();
		await fake.fire("session_start", { type: "session_start" }, ctx);
		await fake.fire("before_agent_start", { type: "before_agent_start", systemPromptOptions: { cwd: ctx.cwd, customPrompt: "Agent prompt" } }, ctx);
		expect(requestSystemPrompt(fake.events, ctx)).toBeUndefined();
	});
});
