/**
 * The classifier's model-fallback behavior, with the provider call mocked.
 *
 * These exist because the fallback path is where two real bugs lived: a pinned
 * model that died mid-session was retried forever (the chain never re-consulted),
 * and the "everything rejected" retry grabbed the cost-ranked pick instead of the
 * session model. Both only show up across *sequences* of calls, which is exactly
 * what the prompt/parse unit tests never exercise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: vi.fn(),
}));

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { classify, createClassifierState } from "../../extensions/auto-mode/classifier.ts";
import { loadAutoModeConfig } from "../../extensions/auto-mode/config.ts";
import { isModelUnavailableError } from "../../extensions/auto-mode/model-select.ts";

const completeMock = vi.mocked(completeSimple);

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

const allowReply = () =>
	({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow"}' }], usage: {} }) as any;
const errorReply = (errorMessage: string) => ({ stopReason: "error", errorMessage, content: [] }) as any;

const config = loadAutoModeConfig("/nonexistent-home-for-tests");

const request = {
	toolName: "bash",
	input: { command: "npm test" },
	cwd: "/repo",
	userMessages: ["run the tests"],
	routedBecause: "no rule covered this call",
};

/** An openai session where the chain is: gpt-5-mini (provider default) → session. */
const sessionModel = model("openai", "gpt-5.1", 10);
const miniModel = model("openai", "gpt-5-mini", 0.25);
const tinyModel = model("openai", "my-tiny-model", 0.01);

function makeDeps(overrides: Partial<Parameters<typeof classify>[1]> = {}) {
	const notices: string[] = [];
	const deps = {
		registry: {
			getAvailable: () => [sessionModel, miniModel, tinyModel],
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
		} as any,
		sessionModel,
		config,
		state: createClassifierState(),
		onNotice: (message: string) => notices.push(message),
		...overrides,
	};
	return { deps, notices };
}

beforeEach(() => {
	completeMock.mockReset();
});

describe("classify: pinning and fallback", () => {
	it("pins the first model that answers", async () => {
		completeMock.mockResolvedValue(allowReply());
		const { deps } = makeDeps();
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(deps.state.pinned?.id).toBe("gpt-5-mini");
	});

	it("steps off a pinned model that dies, in the same call, and re-pins", async () => {
		// Bug this guards: rejecting the pin without clearing it left the dead
		// model as the only candidate ever tried again — auto mode blocked every
		// call until restart.
		completeMock.mockResolvedValueOnce(allowReply());
		const { deps, notices } = makeDeps();
		await classify(request, deps);
		expect(deps.state.pinned?.id).toBe("gpt-5-mini");

		completeMock.mockImplementation(async (m: any) =>
			m.id === "gpt-5-mini" ? errorReply("404 model not found") : allowReply(),
		);
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(deps.state.rejected.has("openai/gpt-5-mini")).toBe(true);
		expect(deps.state.pinned?.id).toBe("gpt-5.1");
		expect(notices.some((n) => n.includes("cannot use openai/gpt-5-mini"))).toBe(true);
	});

	it("does not reject or unpin on a transient failure", async () => {
		completeMock.mockResolvedValueOnce(allowReply());
		const { deps } = makeDeps();
		await classify(request, deps);

		completeMock.mockResolvedValueOnce(errorReply("500 internal server error"));
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("block");
		expect(verdict.reason).toContain("could not be reached");
		// The same model is tried again next call: switching would paper over
		// something about to clear.
		expect(deps.state.pinned?.id).toBe("gpt-5-mini");
		expect(deps.state.rejected.size).toBe(0);
	});

	const truncatedReply = () =>
		({
			stopReason: "length",
			content: [{ type: "text", text: '{"analysis":"This call only inspects' }],
			usage: {},
		}) as any;

	it("retries a truncated verdict once with more headroom", async () => {
		// Observed live: a model whose reasoning cannot be disabled burned the
		// output budget deliberating and the JSON was cut mid-string. One retry
		// with a larger cap turns that into a verdict instead of a false block.
		completeMock.mockResolvedValueOnce(truncatedReply()).mockResolvedValueOnce(allowReply());
		const { deps } = makeDeps();
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(completeMock).toHaveBeenCalledTimes(2);
		expect((completeMock.mock.calls[0]?.[2] as any).maxTokens).toBe(1024);
		expect((completeMock.mock.calls[1]?.[2] as any).maxTokens).toBe(4096);
	});

	it("blocks with the output limit named when the retry is also truncated, keeping the model", async () => {
		// The generic "unreadable response" pointed a debugging session at the
		// parser when the real cause was the budget. Truncation is per-reply,
		// not a dead model, so nothing is rejected or unpinned.
		completeMock.mockResolvedValueOnce(allowReply());
		const { deps } = makeDeps();
		await classify(request, deps);

		completeMock.mockResolvedValueOnce(truncatedReply()).mockResolvedValueOnce(truncatedReply());
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("block");
		expect(verdict.reason).toContain("output limit");
		expect(deps.state.pinned?.id).toBe("gpt-5-mini");
		expect(deps.state.rejected.size).toBe(0);
	});

	it("retries the session model when every candidate has been rejected — never the cost-ranked pick", async () => {
		const { deps } = makeDeps();
		deps.state.rejected.add("openai/gpt-5-mini");
		deps.state.rejected.add("openai/gpt-5.1");
		deps.state.rejected.add("openai/my-tiny-model");

		completeMock.mockResolvedValue(allowReply());
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect((completeMock.mock.calls[0]?.[0] as any).id).toBe("gpt-5.1");
	});

	it("walks auth failures the same way as provider rejections", async () => {
		const { deps } = makeDeps({
			registry: {
				getAvailable: () => [sessionModel, miniModel, tinyModel],
				getApiKeyAndHeaders: async (m: any) =>
					m.id === "gpt-5-mini" ? { ok: false as const, error: "no key" } : { ok: true as const, apiKey: "key" },
			} as any,
		});
		completeMock.mockResolvedValue(allowReply());
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(deps.state.rejected.has("openai/gpt-5-mini")).toBe(true);
		expect(deps.state.pinned?.id).toBe("gpt-5.1");
	});
});

describe("isModelUnavailableError: quota wording", () => {
	it("treats billing-quota errors as permanent", () => {
		expect(isModelUnavailableError("insufficient_quota")).toBe(true);
		expect(
			isModelUnavailableError("You exceeded your current quota, please check your plan and billing details."),
		).toBe(true);
	});

	it("treats rate-limit quota wording as transient", () => {
		// A bare "quota" match permanently rejected a healthy model over a
		// per-minute blip; misreading transient as permanent is the costly direction.
		expect(isModelUnavailableError("quota exceeded, retry in 60 seconds")).toBe(false);
		expect(isModelUnavailableError("429 rate limit: quota resets shortly")).toBe(false);
	});
});
