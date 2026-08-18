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
import {
	classify,
	createClassifierState,
	isClassifierTimeout,
	ROTATE_AFTER_TIMEOUTS,
} from "../../extensions/auto-mode/classifier.ts";
import { loadAutoModeConfig } from "../../extensions/auto-mode/config.ts";
import { isModelUnavailableError } from "../../extensions/auto-mode/model-select.ts";

const completeMock = vi.mocked(completeSimple);

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

// A stage-1 severity below the threshold ⇒ allow with no stage 2, so an allow is
// a single provider call — which keeps the fallback call-count assertions clean.
const allowReply = () =>
	({ stopReason: "stop", content: [{ type: "text", text: "<severity>5</severity>" }], usage: {} }) as any;
const errorReply = (errorMessage: string) => ({ stopReason: "error", errorMessage, content: [] }) as any;

const config = loadAutoModeConfig("/nonexistent-home-for-tests");

const request = {
	toolName: "bash",
	transcript: [
		{ kind: "user" as const, text: "run the tests" },
		{ kind: "tool" as const, tool: "bash", input: { command: "npm test" } },
	],
	userMessages: ["run the tests"],
	username: "tester",
	environment: config.environment,
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

	it("caches the candidate chain, rebuilding only when the session model or config changes", async () => {
		// The chain build is O(catalog); the session commits to one classifier, so it
		// should be ranked once and reused, not rebuilt on every gated call.
		completeMock.mockResolvedValue(allowReply());
		let catalogReads = 0;
		const registry = {
			getAvailable: () => {
				catalogReads++;
				return [sessionModel, miniModel, tinyModel];
			},
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
		} as any;
		const deps = { registry, sessionModel, config, state: createClassifierState(), onNotice: () => {} };

		await classify(request, deps);
		await classify(request, deps);
		await classify(request, deps);
		expect(catalogReads).toBe(1); // built once, reused across calls

		// Session-model change → signature changes → rebuild.
		await classify(request, { ...deps, sessionModel: model("openai", "gpt-5-mini", 0.25) });
		expect(catalogReads).toBe(2);

		// classifierModel config change → rebuild too.
		await classify(request, { ...deps, config: { ...config, classifierModel: "openai/gpt-5-mini" } });
		expect(catalogReads).toBe(3);
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
		// Stage 1's cap is 64 (like CC); a truncated reply retries with headroom.
		expect((completeMock.mock.calls[0]?.[2] as any).maxTokens).toBe(64);
		expect((completeMock.mock.calls[1]?.[2] as any).maxTokens).toBe(1024);
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

describe("classify: reasoning-mandatory fallback", () => {
	// The test models carry no thinkingLevelMap, so forcedReasoningLevel returns
	// undefined (the off-request is attempted) and reasoningRetryLevel returns
	// "minimal" — i.e. these exercise the REACTIVE path (a metadata-gap model that
	// only reveals it can't disable thinking via the provider's 400).
	const mandatoryReply = () => errorReply("400 Reasoning is mandatory for this endpoint and cannot be disabled");

	it("retries the SAME candidate at its floor when it rejects thinking-off, then pins and memoizes", async () => {
		const { deps, notices } = makeDeps();
		// gpt-5-mini (the provider-default candidate tried first) 400s on the
		// off-request; the retry with forced thinking succeeds on the same model.
		completeMock.mockResolvedValueOnce(mandatoryReply()).mockResolvedValue(allowReply());
		const verdict = await classify(request, deps);

		expect(verdict.decision).toBe("allow");
		expect(deps.state.pinned?.id).toBe("gpt-5-mini"); // retried in place, not stepped past
		expect(deps.state.forcedReasoning.get("openai/gpt-5-mini")).toBe("minimal"); // learned + remembered
		expect(deps.state.rejected.has("openai/gpt-5-mini")).toBe(false); // a forced-reasoning 400 is not "unusable"
		expect(notices.some((n) => /cannot run with thinking disabled/.test(n))).toBe(true);
		// First attempt sent no reasoning (off); the retry sent minimal.
		expect(completeMock.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
		expect(completeMock.mock.calls[1]?.[2]?.reasoning).toBe("minimal");
	});

	it("sends the memoized level up front on a later call, with no wasted 400", async () => {
		const { deps } = makeDeps();
		deps.state.forcedReasoning.set("openai/gpt-5-mini", "minimal");
		completeMock.mockResolvedValue(allowReply());

		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(completeMock).toHaveBeenCalledTimes(1); // no failed off-attempt
		expect(completeMock.mock.calls[0]?.[2]?.reasoning).toBe("minimal");
	});

	it("retries at most once — a second mandatory-thinking 400 is surfaced, not looped", async () => {
		const { deps } = makeDeps();
		// The candidate 400s on both the off-attempt and the forced retry. The key
		// guarantee is that the re-queue does NOT loop forever: after one forced
		// retry, the persistent error surfaces as a block (the existing
		// "substantive error → block" contract), so completeSimple runs exactly
		// twice for that candidate, not endlessly.
		completeMock.mockImplementation(async (m: any) =>
			m.id === "gpt-5-mini" ? mandatoryReply() : allowReply(),
		);
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("block");
		expect(completeMock).toHaveBeenCalledTimes(2); // off, then minimal — no third attempt
	});

	it("does not treat an ordinary provider error as reasoning-mandatory", async () => {
		const { deps } = makeDeps();
		completeMock.mockResolvedValue(errorReply("500 internal server error"));
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("block");
		expect(deps.state.forcedReasoning.size).toBe(0); // never learned a level
	});
});

const abortedReply = () => ({ stopReason: "aborted", errorMessage: "Request aborted", content: [] }) as any;

describe("classify: timeout handling", () => {
	it("retries the same model once on a timeout, then takes the verdict", async () => {
		// A stall under load usually clears on a second try — one retry turns it
		// into a verdict instead of a false block.
		completeMock.mockResolvedValueOnce(abortedReply()).mockResolvedValueOnce(allowReply());
		const { deps } = makeDeps();
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("allow");
		expect(completeMock).toHaveBeenCalledTimes(2);
		expect((completeMock.mock.calls[0]?.[0] as any).id).toBe((completeMock.mock.calls[1]?.[0] as any).id);
	});

	it("surfaces an all-timeout as its own tier, and rejects nothing (timeouts are transient)", async () => {
		completeMock.mockResolvedValue(abortedReply());
		const { deps } = makeDeps();
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("block");
		expect(verdict.tier).toBe("timeout");
		expect(verdict.reason).toContain("in time");
		// Names the tool under review and the model that timed out (CC-aligned copy),
		// so the model knows what was blocked and that it can wait/retry.
		expect(verdict.reason).toContain("bash");
		expect(verdict.reason).toContain("temporarily unavailable");
		// A timeout must never look like a substantive "could not be reached" error.
		expect(verdict.reason).not.toContain("could not be reached");
		expect(deps.state.rejected.size).toBe(0);
	});

	it(`unpins a model after ${ROTATE_AFTER_TIMEOUTS} consecutive timeouts, so the session re-picks`, async () => {
		completeMock.mockResolvedValueOnce(allowReply());
		const { deps } = makeDeps();
		await classify(request, deps);
		expect(deps.state.pinned?.id).toBe("gpt-5-mini");

		completeMock.mockResolvedValue(abortedReply());
		for (let i = 0; i < ROTATE_AFTER_TIMEOUTS; i++) {
			const verdict = await classify(request, deps);
			expect(verdict.tier).toBe("timeout");
		}
		expect(deps.state.pinned).toBeUndefined();
		expect(deps.state.rejected.size).toBe(0);
	});

	it("treats a user cancel as a cancel, not a timeout — no retry, no rotation", async () => {
		completeMock.mockResolvedValue(abortedReply());
		const { deps } = makeDeps({ signal: AbortSignal.abort() });
		const verdict = await classify(request, deps);
		expect(verdict.decision).toBe("block");
		expect(verdict.reason).toContain("cancelled");
		// One attempt, no retry: the user asked to stop.
		expect(completeMock).toHaveBeenCalledTimes(1);
	});
});

describe("isClassifierTimeout", () => {
	it('matches abort/timeout wording — including "aborted" (the observed message)', () => {
		// Regression: a trailing \b made /\babort\b/ miss "aborted", so real
		// timeouts fell through to the generic-error path with the wrong tier.
		for (const message of ["Request aborted", "Request was aborted", "aborting", "timed out", "timeout", "ETIMEDOUT", "deadline exceeded"]) {
			expect(isClassifierTimeout(message)).toBe(true);
		}
	});

	it("does not match substantive provider errors", () => {
		for (const message of ["500 internal server error", "invalid_model", "no such model", "429 rate limit"]) {
			expect(isClassifierTimeout(message)).toBe(false);
		}
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
