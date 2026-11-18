import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN_FAILED_CHANNEL } from "../../extensions/lib/notify/interrupt.ts";
import { RUNAWAY_PADDING_LIMIT, trailingPadding } from "../../extensions/request/tool-call-corruption/tool-call-corruption.ts";
import toolCallCorruptionExtension from "../../extensions/request/tool-call-corruption/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("trailingPadding", () => {
	it("counts the blank run after the last argument character, and whether it holds a raw tab or newline", () => {
		let state = trailingPadding(undefined, '{"command":"ls"');
		expect(state).toEqual({ run: 0, structural: false });
		state = trailingPadding(state, "   ");
		expect(state).toEqual({ run: 3, structural: false });
		state = trailingPadding(state, "\t\n ");
		expect(state).toEqual({ run: 6, structural: true });
		// Any argument character ends the run.
		expect(trailingPadding(state, " }\n")).toEqual({ run: 1, structural: true });
	});

	it("never counts spaces alone: a JSON string can hold them, never a raw tab or newline", () => {
		expect(trailingPadding(undefined, " ".repeat(RUNAWAY_PADDING_LIMIT * 2)).structural).toBe(false);
	});
});

// Battery round 7: gpt-6.1-sol streamed tabs and newlines into one tool call for
// 25 minutes (26 MB of events) until the run's own alarm killed it.
describe("a runaway tool-call stream on any provider", () => {
	let fake: FakePi;
	let ctx: ReturnType<typeof createFakeCtx>;

	beforeEach(async () => {
		fake = createFakePi();
		ctx = createFakeCtx({ model: { provider: "openai-codex", id: "gpt-6.1-sol" }, mode: "json", hasUI: false });
		vi.spyOn(console, "error").mockImplementation(() => {});
		toolCallCorruptionExtension(fake.pi as never);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("agent_start", {}, ctx);
	});
	afterEach(async () => {
		await fake.fire("session_shutdown", {}, ctx);
		vi.restoreAllMocks();
	});

	const stream = async (deltas: string[], toolName?: string) => {
		const partial = { role: "assistant", content: toolName ? [{ type: "toolCall", id: "call_1", name: toolName, arguments: {} }] : [] };
		const update = (event: object) => fake.fire("message_update", { message: partial, assistantMessageEvent: { ...event, partial } }, ctx);
		await fake.fire("message_start", { message: { role: "assistant" } }, ctx);
		await update({ type: "toolcall_start", contentIndex: 0 });
		for (const delta of deltas) await update({ type: "toolcall_delta", contentIndex: 0, delta });
	};

	it("stops the turn as a failure once the blank padding passes the limit", async () => {
		const failed: unknown[] = [];
		fake.events.on(TURN_FAILED_CHANNEL, (data) => failed.push(data));
		await stream(['{"command":"git log', "\t", "\n", ...Array.from({ length: RUNAWAY_PADDING_LIMIT / 12 + 1 }, () => "           \t")]);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(failed).toEqual([{ reason: expect.stringContaining("blank space") }]);
	});

	it("stops the turn once a call's arguments end in one unit repeated past the tool's limit, naming the tool and the unit", async () => {
		// The incident: GPT-6.1 Terra looping on "Lspnull" inside a bash call's description (findings §94).
		const { rawArguments } = JSON.parse(readFileSync(join(__dirname, "fixtures", "runaway-repeat-incident.json"), "utf8")) as { rawArguments: string };
		const failed: unknown[] = [];
		fake.events.on(TURN_FAILED_CHANNEL, (data) => failed.push(data));
		const deltas = Array.from({ length: Math.ceil(rawArguments.length / 23) }, (_, i) => rawArguments.slice(i * 23, i * 23 + 23));
		await stream(deltas, "bash");
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(failed).toEqual([{ reason: 'The model kept repeating "Lspnull" in a bash call\'s arguments for over 8,192 characters without finishing the call, so the turn was stopped.' }]);
	});

	it("leaves an ordinary pretty-printed call alone", async () => {
		await stream(['{\n\t"command": "ls",\n', '\t"description": "List"\n}']);
		expect(ctx.abort).not.toHaveBeenCalled();
	});
});
