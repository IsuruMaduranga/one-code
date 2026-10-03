/**
 * Claude Code's layout on a model that takes a mid-conversation system message:
 * the session-fact blocks leave the first user message for one system message
 * right after it; the instructions and context blocks stay.
 */
import { describe, expect, it } from "vitest";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { CONTEXT_ORDER, movesToSystemRole, REMINDER_CHANNEL, wrapReminder } from "../../extensions/lib/reminders.ts";
import { instructionRole, withSystemRoleContext } from "../../extensions/lib/system-role.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const ENV = { framed: wrapReminder("# Environment\nx"), inner: "# Environment\nx" };
const DATE = { framed: wrapReminder("Today's date is 2026-10-04."), inner: "Today's date is 2026-10-04." };
const CLAUDE_MD = wrapReminder("Codebase and user instructions are shown below.");

describe("movesToSystemRole", () => {
	it("moves the facts below the instructions block and the date, and keeps the rest", () => {
		for (const order of [CONTEXT_ORDER.environment, CONTEXT_ORDER.modelLine, CONTEXT_ORDER.deferredTools, CONTEXT_ORDER.agents, CONTEXT_ORDER.mcp, CONTEXT_ORDER.skills, CONTEXT_ORDER.autoModeNote, CONTEXT_ORDER.date]) {
			expect(movesToSystemRole(order), String(order)).toBe(true);
		}
		for (const order of [CONTEXT_ORDER.claudeMd, CONTEXT_ORDER.oneCodeMd, CONTEXT_ORDER.context]) {
			expect(movesToSystemRole(order), String(order)).toBe(false);
		}
	});
});

describe("withSystemRoleContext", () => {
	const anthropicPayload = () => ({
		model: "claude-opus-5-5",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: ENV.framed },
					{ type: "text", text: CLAUDE_MD },
					{ type: "text", text: DATE.framed },
					{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
				],
			},
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	});

	it("lifts the blocks into one system message after the user message, unwrapped and a blank line apart", () => {
		const payload = anthropicPayload();
		payload.messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] } as never);
		const out = withSystemRoleContext(payload, "anthropic", [ENV, DATE], "system") as { messages: unknown[] };
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: CLAUDE_MD },
					{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
				],
			},
			{ role: "system", content: [{ type: "text", text: "# Environment\nx\n\nToday's date is 2026-10-04." }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
	});

	it("moves the cache mark onto the system message when only pi's empty effort messages follow", () => {
		const payload = anthropicPayload();
		const out = withSystemRoleContext(payload, "anthropic", [ENV], "system") as { messages: Array<{ content: Array<Record<string, unknown>> }> };
		expect(out.messages[0].content.at(-1)).toEqual({ type: "text", text: "hello" });
		expect(out.messages[1].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("changes nothing when the blocks are not there (a fork's tail), and runs once", () => {
		const tail = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
		expect(withSystemRoleContext(tail, "anthropic", [ENV], "system")).toBeUndefined();
		const once = withSystemRoleContext(anthropicPayload(), "anthropic", [ENV, DATE], "system") as Record<string, unknown>;
		expect(withSystemRoleContext(once, "anthropic", [ENV, DATE], "system")).toBeUndefined();
	});

	it("writes the OpenAI shapes with the API's role", () => {
		const responses = { input: [{ role: "developer", content: "prompt" }, { role: "user", content: [{ type: "input_text", text: ENV.framed }, { type: "input_text", text: "hi" }] }] };
		const out = withSystemRoleContext(responses, "responses", [ENV], "developer") as { input: unknown[] };
		expect(out.input.slice(1)).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "developer", content: ENV.inner }]);
		const completions = { messages: [{ role: "system", content: "prompt" }, { role: "user", content: [{ type: "text", text: ENV.framed }, { type: "text", text: "hi" }] }] };
		expect((withSystemRoleContext(completions, "completions", [ENV], "system") as { messages: unknown[] }).messages[2]).toEqual({ role: "system", content: ENV.inner });
	});

	it("picks the role pi gives a system message on each API", () => {
		expect(instructionRole("anthropic", { reasoning: true })).toBe("system");
		expect(instructionRole("responses", { reasoning: true })).toBe("developer");
		expect(instructionRole("responses", { reasoning: true, compat: { supportsDeveloperRole: false } })).toBe("system");
		expect(instructionRole("completions", { reasoning: true })).toBe("system");
		expect(instructionRole("completions", { reasoning: true, compat: { supportsDeveloperRole: true } })).toBe("developer");
	});
});

describe("system-reminder's layout hook", () => {
	const flagged = { id: "claude-opus-5-5", api: "anthropic-messages", provider: "anthropic", compat: { supportsMidConvoSystemMessages: true } };
	const haiku = { id: "claude-haiku-4-5", api: "anthropic-messages", provider: "anthropic", compat: {} };

	async function run(model: Record<string, unknown>) {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const emit = (text: string, order: number, extra: Record<string, unknown> = {}) =>
			fake.events.emit(REMINDER_CHANNEL, { text, scope: "every-turn", key: text, placement: "first-prepend", order, ...extra });
		emit("# Environment\nx", CONTEXT_ORDER.environment);
		emit("While auto mode is active:\n\nnote", CONTEXT_ORDER.autoModeNote, { systemRoleOnly: true });
		emit("Codebase and user instructions are shown below.", CONTEXT_ORDER.claudeMd);
		emit("Today's date is 2026-10-04.", CONTEXT_ORDER.date);
		const ctx = createFakeCtx({ model });
		const messages = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }];
		const shaped = await fake.fireOne<{ messages: Array<{ content: Array<{ text: string }> }> }>("context", { messages }, ctx);
		const wireUser = { role: "user", content: shaped!.messages[0].content.map((block) => ({ type: "text", text: block.text })) };
		const payload = await fake.fireOne<{ messages: Array<{ role: string; content: Array<{ text: string }> }>; betas?: string[] }>(
			"before_provider_request",
			{ payload: { model: model.id, messages: [wireUser] } },
			ctx,
		);
		return { shaped: shaped!.messages[0].content.map((block) => block.text), payload };
	}

	it("moves the facts and the date into a system message on a flagged model, with the beta", async () => {
		const { payload } = await run(flagged);
		expect(payload!.messages.map((m) => m.role)).toEqual(["user", "system"]);
		expect(payload!.messages[0].content.map((b) => b.text)).toEqual([wrapReminder("Codebase and user instructions are shown below."), "hello"]);
		expect(payload!.messages[1].content[0].text).toBe("# Environment\nx\n\nWhile auto mode is active:\n\nnote\n\nToday's date is 2026-10-04.");
		expect(payload!.betas).toEqual(["mid-conversation-system-2026-04-07"]);
	});

	it("keeps Claude Code's first-message order elsewhere, without the system-only note", async () => {
		const { shaped, payload } = await run(haiku);
		expect(payload).toBeUndefined();
		expect(shaped).toEqual([
			wrapReminder("# Environment\nx"),
			wrapReminder("Codebase and user instructions are shown below."),
			wrapReminder("Today's date is 2026-10-04."),
			"hello",
		]);
	});
});
