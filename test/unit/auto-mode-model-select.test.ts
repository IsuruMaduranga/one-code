import { describe, expect, it } from "vitest";
import {
	classifierCandidates,
	describeCandidate,
	findConfigured,
	isModelUnavailableError,
	PROVIDER_DEFAULT_CLASSIFIERS,
} from "../../extensions/auto-mode/model-select.ts";

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

const pick = (available: any[], sessionModel: any, configured?: string) =>
	classifierCandidates({ available, sessionModel, configured });

describe("classifierCandidates: provider containment", () => {
	it("never leaves the session's provider on its own initiative", () => {
		// The bug this exists to prevent: an openai-codex session with an Anthropic
		// key also configured used to send the user's prompts, CLAUDE.md, and command
		// text to Anthropic through a component with no UI.
		const available = [model("openai-codex", "gpt-5.5-codex", 10), model("anthropic", "claude-haiku-4-5", 1)];
		const chain = pick(available, model("openai-codex", "gpt-5.5-codex", 10));
		expect(chain.length).toBeGreaterThan(0);
		for (const candidate of chain) {
			expect(candidate.model.provider, candidate.model.id).toBe("openai-codex");
		}
	});

	it("crosses providers only when the user names one explicitly", () => {
		const available = [model("ollama", "qwen3-coder"), model("anthropic", "claude-haiku-4-5", 1)];
		const chain = pick(available, model("ollama", "qwen3-coder"), "anthropic/claude-haiku-4-5");
		expect(chain[0].model.provider).toBe("anthropic");
		expect(chain[0].source).toBe("configured");
	});

	it("still ends the chain at the session model, so an explicit model failing is survivable", () => {
		const available = [model("ollama", "qwen3-coder"), model("anthropic", "claude-haiku-4-5", 1)];
		const chain = pick(available, model("ollama", "qwen3-coder"), "anthropic/claude-haiku-4-5");
		expect(chain[chain.length - 1].model.provider).toBe("ollama");
	});
});

describe("classifierCandidates: cost", () => {
	it("prefers the cheapest genuinely-priced model in the provider", () => {
		// gpt-5-nano is both the cheapest here and a provider default, so it wins
		// either way; the point is that the expensive session model is not reused.
		const available = [
			model("openai", "gpt-5.5", 10),
			model("openai", "gpt-4o-mini", 0.15),
			model("openai", "gpt-5-nano", 0.05),
		];
		// Which label it arrives under does not matter; which model does.
		const chain = pick(available, model("openai", "gpt-5.5", 10));
		expect(chain[0].model.id).toBe("gpt-5-nano");
	});

	it("sorts by cost when no provider default matches", () => {
		const available = [
			model("acme", "big-model", 20),
			model("acme", "medium-model", 3),
			model("acme", "tiny-model", 0.2),
		];
		const chain = pick(available, model("acme", "big-model", 20));
		expect(chain[0].source).toBe("cheapest-in-provider");
		expect(chain[0].model.id).toBe("tiny-model");
	});

	it("treats sentinel and zero prices as unpriced, not as cheap", () => {
		// pi carries -1000000 for OpenRouter's router pseudo-models and 0 for
		// free-tier entries; both would win a naive cheapest-first sort.
		const available = [
			model("openrouter", "openrouter/auto", -1000000),
			model("openrouter", "free/thing", 0),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-fable-5", 15),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-fable-5", 15));
		for (const candidate of chain) {
			expect(candidate.model.id, candidate.model.id).not.toBe("openrouter/auto");
			expect(candidate.model.id, candidate.model.id).not.toBe("free/thing");
		}
	});

	it("never picks a model more expensive than the session's own", () => {
		const available = [model("anthropic", "claude-fable-5", 15), model("anthropic", "claude-opus-5", 30)];
		const chain = pick(available, model("anthropic", "claude-fable-5", 15));
		for (const candidate of chain) {
			expect(candidate.model.id, candidate.model.id).not.toBe("claude-opus-5");
		}
	});

	it("falls back to the session model when nothing in the provider is priced", () => {
		// A local setup: no cost data anywhere, and no name hints either.
		const available = [model("ollama", "qwen3-coder"), model("ollama", "llama3")];
		const chain = pick(available, model("ollama", "qwen3-coder"));
		expect(chain).toHaveLength(1);
		expect(chain[0].source).toBe("session");
		expect(chain[0].model.id).toBe("qwen3-coder");
	});
});

describe("classifierCandidates: provider defaults", () => {
	it("uses the known-good default for a messy catalog before cost sorting", () => {
		const available = [
			model("openrouter", "zzz/cheapest-but-unknown", 0.01),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-fable-5", 15),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-fable-5", 15));
		expect(chain[0].source).toBe("provider-default");
		expect(chain[0].model.id).toBe("anthropic/claude-haiku-4.5");
		// The cheap unknown is still in the chain as a later fallback.
		expect(chain.some((c) => c.model.id === "zzz/cheapest-but-unknown")).toBe(true);
	});

	it("accepts a dated variant of a default", () => {
		const available = [model("anthropic", "claude-haiku-4-5-20251001", 1), model("anthropic", "claude-fable-5", 15)];
		const chain = pick(available, model("anthropic", "claude-fable-5", 15));
		expect(chain[0].model.id).toBe("claude-haiku-4-5-20251001");
	});

	it("skips a provider default that is not actually available", () => {
		const available = [model("anthropic", "claude-fable-5", 15)];
		const chain = pick(available, model("anthropic", "claude-fable-5", 15));
		expect(chain.every((c) => c.source !== "provider-default")).toBe(true);
	});

	it("covers the providers whose catalogs name-matching cannot handle", () => {
		// Groq's models contain none of the usual "cheap model" substrings, and
		// neither do xAI's — cost or a default table is the only way to choose.
		for (const provider of ["groq", "xai", "openrouter", "openai", "google"]) {
			expect(PROVIDER_DEFAULT_CLASSIFIERS[provider], provider).toBeDefined();
		}
	});

	it("picks a groq classifier despite no name hints existing there", () => {
		const available = [
			model("groq", "llama-3.1-8b-instant", 0.05),
			model("groq", "llama-3.3-70b-versatile", 0.6),
		];
		const chain = pick(available, model("groq", "llama-3.3-70b-versatile", 0.6));
		expect(chain[0].model.id).toBe("llama-3.3-70b-versatile");
		expect(chain[0].source).toBe("provider-default");
	});
});

describe("findConfigured", () => {
	const available = [model("anthropic", "claude-haiku-4-5-20251001", 1), model("openai", "gpt-5-mini", 0.25)];

	it("accepts provider/id, a bare id, and a prefix", () => {
		expect(findConfigured(available, "openai/gpt-5-mini")?.id).toBe("gpt-5-mini");
		expect(findConfigured(available, "gpt-5-mini")?.id).toBe("gpt-5-mini");
		expect(findConfigured(available, "anthropic/claude-haiku-4-5")?.id).toBe("claude-haiku-4-5-20251001");
	});

	it("returns undefined for something not available", () => {
		expect(findConfigured(available, "anthropic/claude-opus-5")).toBeUndefined();
		expect(findConfigured(available, "")).toBeUndefined();
	});
});

describe("isModelUnavailableError", () => {
	it("recognises errors that mean this model will never work here", () => {
		for (const message of [
			"404 model not found",
			"403 Forbidden",
			"401 unauthorized",
			"The model `gpt-9` does not exist",
			"you do not have access to this model",
			"insufficient_quota",
			"invalid_model",
		]) {
			expect(isModelUnavailableError(message), message).toBe(true);
		}
	});

	it("does not mistake a transient failure for an unusable model", () => {
		// Switching models on these would paper over something about to clear.
		for (const message of ["socket hang up", "500 internal server error", "ETIMEDOUT", "529 overloaded_error"]) {
			expect(isModelUnavailableError(message), message).toBe(false);
		}
	});
});

describe("describeCandidate", () => {
	it("says where each choice came from", () => {
		expect(describeCandidate({ model: model("openai", "gpt-5-mini", 0.25), source: "configured" })).toContain(
			"autoMode.classifierModel",
		);
		expect(describeCandidate({ model: model("groq", "llama-3.3-70b-versatile", 0.6), source: "session" })).toContain(
			"no cheaper one found",
		);
	});
});
