import { beforeEach, describe, expect, it, vi } from "vitest";
let btwExtension: typeof import("../../extensions/btw/index.ts").default;
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
vi.mock("../../extensions/lib/side-call-usage.ts", () => ({ logSideCallUsage: vi.fn() }));

const complete = vi.mocked(completeSimple);
const { logSideCallUsage } = await import("../../extensions/lib/side-call-usage.ts");
const logSideCall = vi.mocked(logSideCallUsage);
const answer = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop", usage: {} }) as Awaited<ReturnType<typeof completeSimple>>;
beforeEach(async () => {
	complete.mockReset();
	logSideCall.mockReset();
	btwExtension = (await import("../../extensions/btw/index.ts")).default;
});

function setup(model = { api: "anthropic-messages", provider: "anthropic", id: "test" }) {
	const fake = createFakePi();
	btwExtension(fake.pi as never);
	const ctx = createFakeCtx({
		mode: "rpc", hasUI: true,
		model,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
	});
	const ui = ctx.ui as { custom: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
	const ask = (question: string) => fake.commands.get("btw")!.handler(question, ctx);
	return { fake, ctx, ui, ask };
}

describe("/btw in RPC", () => {
	it("delivers the side answer without custom UI or a main-conversation message", async () => {
		const t = setup();
		complete.mockResolvedValue(answer("The side answer."));
		await t.ask("A side question?");
		expect(complete).toHaveBeenCalledTimes(1);
		expect(t.ui.notify).toHaveBeenCalledWith("The side answer.", "info");
		expect(t.ui.custom).not.toHaveBeenCalled();
		expect(t.fake.sentMessages).toEqual([]);
		expect(t.fake.sentUserMessages).toEqual([]);
	});

	it("threads answered side questions into later side calls only", async () => {
		const t = setup();
		complete.mockResolvedValueOnce(answer("First answer.")).mockResolvedValueOnce(answer("Second answer."));
		await t.ask("First question?");
		await t.ask("Second question?");
		expect(complete.mock.calls[1]?.[1].messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "First answer." }] }),
		]));
		expect(t.fake.sentMessages).toEqual([]);
	});

	it("gives the standalone Anthropic call a stable cache key and moves its marker off the question", async () => {
		const t = setup();
		complete.mockResolvedValue(answer("The side answer."));
		await t.ask("A side question?");
		const options = complete.mock.calls[0]?.[2]!;
		expect.soft(options.sessionId).toBe("fake-session:btw");
		expect.soft(options.onPayload).toBeTypeOf("function");
		const payload = {
			tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
			system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Earlier conversation" }] },
				{ role: "user", content: [{ type: "text", text: "A side question?", cache_control: { type: "ephemeral" } }] },
			],
		};
		if (typeof options.onPayload === "function") options.onPayload(payload, {} as never);
		expect.soft((payload.messages[0].content[0] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });
		expect.soft((payload.messages[1].content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
	});

	it("does not install the Anthropic payload hook for other provider APIs", async () => {
		const t = setup({ api: "openai-responses", provider: "openai", id: "gpt-test" });
		complete.mockResolvedValue(answer("The side answer."));
		await t.ask("A side question?");
		const options = complete.mock.calls[0]?.[2]!;
		expect(options.sessionId).toBe("fake-session:btw");
		expect(options.onPayload).toBeUndefined();
	});

	it("logs every reasoning retry with the same standalone cache key", async () => {
		const t = setup();
		complete
			.mockResolvedValueOnce({ content: [], stopReason: "error", errorMessage: "Reasoning is mandatory and cannot be disabled.", usage: { attempt: 1 } } as unknown as Awaited<ReturnType<typeof completeSimple>>)
			.mockResolvedValueOnce(answer("The side answer."));
		await t.ask("A side question?");
		expect(complete).toHaveBeenCalledTimes(2);
		for (const [, , options] of complete.mock.calls) {
			expect(options?.sessionId).toBe("fake-session:btw");
			expect(options?.onPayload).toBeTypeOf("function");
		}
		expect(logSideCall).toHaveBeenCalledTimes(2);
		expect(logSideCall).toHaveBeenNthCalledWith(1, expect.objectContaining({
			kind: "btw",
			sessionId: "fake-session:btw",
			system: "",
		}), expect.objectContaining({ stopReason: "error" }));
	});

	it("reports a side-call failure through an RPC notification", async () => {
		const t = setup();
		complete.mockRejectedValue(new Error("Connection closed"));
		await t.ask("A question?");
		expect(t.ui.notify).toHaveBeenCalledWith("Side question failed: Connection closed", "error");
	});

	it("aborts on shutdown and does not publish a late answer", async () => {
		const t = setup();
		let resolve!: (value: Awaited<ReturnType<typeof completeSimple>>) => void;
		complete.mockImplementation(() => new Promise((done) => { resolve = done; }));
		const running = t.ask("A question?");
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		const signal = complete.mock.calls[0][2]!.signal!;
		await t.fake.fire("session_shutdown", {}, t.ctx);
		expect(signal.aborted).toBe(true);
		resolve(answer("Too late."));
		await running;
		expect(t.ui.notify).not.toHaveBeenCalled();
	});
});
