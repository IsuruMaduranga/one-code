import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
vi.mock("../../extensions/lib/side-call-usage.ts", () => ({ logSideCallUsage: vi.fn() }));

const complete = vi.mocked(completeSimple);
const { logSideCallUsage } = await import("../../extensions/lib/side-call-usage.ts");
const logSideCall = vi.mocked(logSideCallUsage);
const answer = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop", usage: {} }) as Awaited<ReturnType<typeof completeSimple>>;
let recapExtension: typeof import("../../extensions/recap/index.ts").default;

beforeEach(async () => {
	vi.useFakeTimers();
	process.env.CC_RECAP_IDLE_MS = "1000";
	delete process.env.CC_RECAP;
	complete.mockReset();
	logSideCall.mockReset();
	recapExtension = (await import("../../extensions/recap/index.ts")).default;
});

afterEach(() => {
	delete process.env.CC_RECAP_IDLE_MS;
	vi.useRealTimers();
});

async function scheduleRecap(model = { api: "anthropic-messages", provider: "anthropic", id: "test" }) {
	const fake = createFakePi();
	recapExtension(fake.pi as never);
	const ctx = createFakeCtx({
		hasUI: true,
		model,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
	});
	await fake.fire("session_start", {}, ctx);
	await fake.fire("context", { messages: [{ role: "user", content: "Earlier conversation.", timestamp: 1 }] }, ctx);
	await fake.fire("agent_settled", {}, ctx);
	await vi.advanceTimersByTimeAsync(1000);
	await vi.waitFor(() => expect(complete).toHaveBeenCalled());
	return { fake, ctx };
}

describe("standalone recap cache wiring", () => {
	it("uses the recap-specific session key and moves Anthropic's marker off the recap prompt", async () => {
		const payloads: Record<string, unknown>[] = [];
		complete.mockImplementation(async (_model, _context, options) => {
			const payload = {
				messages: [
					{ role: "user", content: [{ type: "text", text: "Earlier conversation." }] },
					{ role: "user", content: [{ type: "text", text: "Recap prompt", cache_control: { type: "ephemeral" } }] },
				],
			};
			options?.onPayload?.(payload, {} as never);
			payloads.push(payload);
			return answer("A recap.");
		});

		await scheduleRecap();

		const options = complete.mock.calls[0]?.[2]!;
		expect(options.sessionId).toBe("fake-session:recap");
		expect(options.onPayload).toBeTypeOf("function");
		expect(payloads[0]?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Earlier conversation.", cache_control: { type: "ephemeral" } }] },
			{ role: "user", content: [{ type: "text", text: "Recap prompt" }] },
		]);
		expect(logSideCall).toHaveBeenCalledWith(expect.objectContaining({
			kind: "recap",
			sessionId: "fake-session:recap",
			system: "",
		}), expect.objectContaining({ stopReason: "stop" }));
	});

	it("leaves other APIs without the Anthropic payload hook", async () => {
		complete.mockResolvedValue(answer("A recap."));
		await scheduleRecap({ api: "openai-responses", provider: "openai", id: "gpt-test" });
		const options = complete.mock.calls[0]?.[2]!;
		expect(options.sessionId).toBe("fake-session:recap");
		expect(options.onPayload).toBeUndefined();
	});

	it("logs every reasoning retry with its stable recap cache key", async () => {
		complete
			.mockResolvedValueOnce({ content: [], stopReason: "error", errorMessage: "Reasoning is mandatory and cannot be disabled.", usage: { attempt: 1 } } as unknown as Awaited<ReturnType<typeof completeSimple>>)
			.mockResolvedValueOnce(answer("A recap."));
		await scheduleRecap();
		expect(complete).toHaveBeenCalledTimes(2);
		for (const [, , options] of complete.mock.calls) expect(options?.sessionId).toBe("fake-session:recap");
		expect(logSideCall).toHaveBeenCalledTimes(2);
		expect(logSideCall).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "recap", sessionId: "fake-session:recap" }), expect.objectContaining({ stopReason: "error" }));
	});
});
