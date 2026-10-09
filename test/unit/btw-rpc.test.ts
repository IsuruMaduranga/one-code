import { beforeEach, describe, expect, it, vi } from "vitest";
let btwExtension: typeof import("../../extensions/btw/index.ts").default;
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));

const complete = vi.mocked(completeSimple);
const answer = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop", usage: {} }) as Awaited<ReturnType<typeof completeSimple>>;
beforeEach(async () => {
	complete.mockReset();
	btwExtension = (await import("../../extensions/btw/index.ts")).default;
});

function setup() {
	const fake = createFakePi();
	btwExtension(fake.pi as never);
	const ctx = createFakeCtx({
		mode: "rpc", hasUI: true,
		model: { api: "anthropic-messages", provider: "anthropic", id: "test" },
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
