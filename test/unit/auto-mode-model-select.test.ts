import { describe, expect, it } from "vitest";
import {
	classifierCandidates,
	describeCandidate,
	findConfigured,
	isModelUnavailableError,
} from "../../extensions/auto-mode/model-select.ts";
import { BUILTIN_PROVIDER_POLICIES, modelIdentity, ROLE_PROFILES } from "../../extensions/lib/model-policy.ts";

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

const pick = (available: any[], sessionModel: any, configured?: string) =>
	classifierCandidates({ available, sessionModel, configured });

describe("classifierCandidates: provider containment", () => {
	it("selects Luna from the OpenAI Codex role profile for a Sol session", () => {
		const available = [
			model("openai-codex", "gpt-5.6-sol", 5),
			model("openai-codex", "gpt-5.6-luna", 0.2),
			model("openai-codex", "gpt-5.4-mini", 0.75),
		];
		const chain = pick(available, available[0]);
		expect(chain[0]).toMatchObject({ model: available[1], source: "role-profile" });
	});

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

describe("classifierCandidates: gateway family containment", () => {
	it("stays with the session's model-creator namespace on a gateway", () => {
		// Same pi provider is not containment on a router: an openai/* session
		// screened by anthropic/* keeps one API key but sends the user's prompts
		// and CLAUDE.md to a vendor they did not pick.
		const available = [
			model("openrouter", "openai/gpt-5.1", 1.25),
			model("openrouter", "openai/gpt-5-mini", 0.25),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
		];
		const chain = pick(available, model("openrouter", "openai/gpt-5.1", 1.25));
		expect(chain[0].model.id).toBe("openai/gpt-5-mini");
		for (const candidate of chain) {
			expect(candidate.model.id.startsWith("openai/"), candidate.model.id).toBe(true);
		}
	});

	it("screens with the session model when its vendor offers nothing cheaper", () => {
		const available = [
			model("openrouter", "z-ai/glm-4.6", 0.5),
			model("openrouter", "openai/gpt-5-mini", 0.25),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
		];
		const chain = pick(available, model("openrouter", "z-ai/glm-4.6", 0.5));
		expect(chain).toHaveLength(1);
		expect(chain[0].model.id).toBe("z-ai/glm-4.6");
		expect(chain[0].source).toBe("session");
	});

	it("uses a cheaper model from the session's own vendor when there is one", () => {
		const available = [model("openrouter", "z-ai/glm-4.6", 0.5), model("openrouter", "z-ai/glm-4.5-air", 0.1)];
		const chain = pick(available, model("openrouter", "z-ai/glm-4.6", 0.5));
		expect(chain[0].model.id).toBe("z-ai/glm-4.5-air");
	});

	it("crosses vendors only on an explicit override", () => {
		const available = [model("openrouter", "z-ai/glm-4.6", 0.5), model("openrouter", "openai/gpt-5-mini", 0.25)];
		const chain = pick(available, model("openrouter", "z-ai/glm-4.6", 0.5), "openrouter/openai/gpt-5-mini");
		expect(chain[0].model.id).toBe("openai/gpt-5-mini");
		expect(chain[0].source).toBe("configured");
	});

	it("does not vendor-split a direct provider that hosts other vendors' weights", () => {
		// Groq serves meta-llama and openai-named open models itself, so the data
		// goes to Groq either way and the prefix implies nothing about routing.
		const available = [
			model("groq", "llama-3.3-70b-versatile", 0.6),
			model("groq", "openai/gpt-oss-20b", 0.075),
		];
		const chain = pick(available, model("groq", "llama-3.3-70b-versatile", 0.6));
		expect(chain.length).toBeGreaterThan(1);
		expect(modelIdentity(model("groq", "openai/gpt-oss-20b", 0.075)).containment).toBe("groq");
	});

	it("normalizes a gateway creator and a direct-provider family", () => {
		expect(modelIdentity(model("openrouter", "anthropic/claude-haiku-4.5", 1)).profile).toBe("anthropic");
		expect(modelIdentity(model("anthropic", "claude-haiku-4-5", 1)).profile).toBe("anthropic");
	});
});

describe("classifierCandidates: cost", () => {
	it("prefers a mini-tier model over the absolute cheapest", () => {
		// gpt-5-nano is cheaper, but the tables stop at the mini/haiku/flash tier:
		// the classifier is a security boundary, so the bottom tier is opt-in via
		// classifierModel rather than the default.
		const available = [
			model("openai", "gpt-5.5", 10),
			model("openai", "gpt-4o-mini", 0.15),
			model("openai", "gpt-5-nano", 0.05),
		];
		const chain = pick(available, model("openai", "gpt-5.5", 10));
		expect(chain[0].model.id).toBe("gpt-4o-mini");
		expect(chain[0].source).toBe("role-profile");
	});

	it("never selects by price on an unknown provider", () => {
		// A custom provider has no reviewed routing semantics. Unknown models stay
		// opaque rather than a cheap neighbor silently becoming the security gate.
		for (const cheapId of ["zzz-obscure", "ling-2.6-flash", "mini-thing"]) {
			const available = [model("acme", "big-model", 20), model("acme", cheapId, 0.01)];
			const chain = pick(available, model("acme", "big-model", 20));
			expect(chain).toHaveLength(1);
			expect(chain[0].source, cheapId).toBe("session");
			expect(chain[0].model.id, cheapId).toBe("big-model");
		}
	});

	it("still sorts the last-resort slot by cost for a known direct provider", () => {
		const available = [
			model("openai", "big-model", 20),
			model("openai", "medium-model", 3),
			model("openai", "small-model", 0.2),
		];
		const chain = pick(available, model("openai", "big-model", 20));
		expect(chain[chain.length - 1].model.id).toBe("small-model");
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

describe("classifierCandidates: never dearer than the session model", () => {
	it("skips a table entry that costs more than the session model", () => {
		// A real case: a $0.50 session was being screened by a $1 model, because the
		// budget ceiling was only applied to the cost-ranked branch.
		const available = [
			model("anthropic", "claude-sonnet-5", 2),
			model("anthropic", "claude-haiku-4-5", 1),
			model("anthropic", "claude-cheap", 0.4),
		];
		const chain = pick(available, model("anthropic", "claude-cheap", 0.4));
		for (const candidate of chain) {
			expect(candidate.model.cost?.input ?? 0, candidate.model.id).toBeLessThanOrEqual(0.4);
		}
	});

	it("uses the table's first entry when the budget allows it", () => {
		const available = [
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-sonnet-4.5", 3),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-sonnet-4.5", 3));
		expect(chain[0].model.id).toBe("anthropic/claude-haiku-4.5");
	});

	it("imposes no ceiling when the session model is unpriced", () => {
		const available = [model("ollama", "qwen3-coder"), model("ollama", "qwen3-mini", 0)];
		const chain = pick(available, model("ollama", "qwen3-coder"));
		expect(chain.length).toBeGreaterThan(0);
	});
});

describe("classifierCandidates: unsuitable variants", () => {
	it("never auto-selects a :batch model, however cheap", () => {
		// Batch endpoints are asynchronous — a blocking gate would wait out its
		// timeout — and they are systematically cheaper, so cost ranking prefers them.
		const available = [
			model("openrouter", "anthropic/claude-haiku-4.5:batch", 0.5),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-sonnet-4.5", 3),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-sonnet-4.5", 3));
		for (const candidate of chain) {
			expect(candidate.model.id, candidate.model.id).not.toContain(":batch");
		}
		expect(chain[0].model.id).toBe("anthropic/claude-haiku-4.5");
	});

	it("also skips :free, :online and :thinking variants", () => {
		for (const suffix of [":free", ":online", ":thinking"]) {
			const available = [
				model("openrouter", `openai/gpt-5-mini${suffix}`, 0.01),
				model("openrouter", "openai/gpt-5-mini", 0.25),
				model("openrouter", "big/model", 5),
			];
			const chain = pick(available, model("openrouter", "big/model", 5));
			for (const candidate of chain) {
				expect(candidate.model.id, `${suffix}: ${candidate.model.id}`).not.toContain(suffix);
			}
		}
	});

	it("honours an explicitly configured variant — naming it is choosing it", () => {
		const available = [model("openrouter", "anthropic/claude-haiku-4.5:batch", 0.5), model("openrouter", "big/model", 5)];
		const chain = pick(available, model("openrouter", "big/model", 5), "openrouter/anthropic/claude-haiku-4.5:batch");
		expect(chain[0].source).toBe("configured");
		expect(chain[0].model.id).toBe("anthropic/claude-haiku-4.5:batch");
	});

	it("does not let a :batch id satisfy a plain table prefix", () => {
		// startsWith would otherwise accept `...haiku-4.5:batch` for `...haiku-4.5`.
		const available = [model("openrouter", "anthropic/claude-haiku-4.5:batch", 0.5), model("openrouter", "big/model", 5)];
		const chain = pick(available, model("openrouter", "big/model", 5));
		expect(chain.every((c) => !c.model.id.includes(":batch"))).toBe(true);
	});
});

describe("classifierCandidates: provider defaults", () => {
	it("uses the known-good default for a messy catalog before cost sorting", () => {
		const available = [
			model("openrouter", "anthropic/claude-cheap-unknown", 0.01),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-fable-5", 15),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-fable-5", 15));
		expect(chain[0].source).toBe("role-profile");
		expect(chain[0].model.id).toBe("anthropic/claude-haiku-4.5");
		// The cheap unknown is still in the chain as a later fallback.
		expect(chain.some((c) => c.model.id === "anthropic/claude-cheap-unknown")).toBe(true);
	});

	it("accepts a dated variant of a default", () => {
		const available = [model("anthropic", "claude-haiku-4-5-20251001", 1), model("anthropic", "claude-fable-5", 15)];
		const chain = pick(available, model("anthropic", "claude-fable-5", 15));
		expect(chain[0].model.id).toBe("claude-haiku-4-5-20251001");
	});

	it("skips a provider default that is not actually available", () => {
		const available = [model("anthropic", "claude-fable-5", 15)];
		const chain = pick(available, model("anthropic", "claude-fable-5", 15));
		expect(chain.every((c) => c.source !== "role-profile")).toBe(true);
	});

	it("covers the providers whose catalogs name-matching cannot handle", () => {
		// Groq's models contain none of the usual "cheap model" substrings, and
		// neither do xAI's — cost or a default table is the only way to choose.
		for (const provider of ["groq", "xai", "openai", "google", "anthropic"]) {
			expect(BUILTIN_PROVIDER_POLICIES[provider], provider).toBeDefined();
		}
		// Gateways reuse short canonical family profiles instead of catalogs.
		for (const vendor of ["anthropic", "openai", "google", "zai", "xai"]) {
			expect(ROLE_PROFILES[vendor], vendor).toBeDefined();
		}
	});

	it("picks a groq classifier despite no name hints existing there", () => {
		const available = [
			model("groq", "llama-3.1-8b-instant", 0.05),
			model("groq", "llama-3.3-70b-versatile", 0.6),
		];
		const chain = pick(available, model("groq", "llama-3.3-70b-versatile", 0.6));
		expect(chain[0].model.id).toBe("llama-3.3-70b-versatile");
		expect(chain[0].source).toBe("role-profile");
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
			"no vetted smaller model within",
		);
		// On a gateway the description names the canonical family, not the gateway.
		expect(
			describeCandidate({ model: model("openrouter", "openai/gpt-5-mini", 0.25), source: "cheapest-in-provider" }),
		).toContain("within openai");
	});
});
