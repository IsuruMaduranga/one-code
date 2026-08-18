import { describe, expect, it } from "vitest";
import {
	classifierCandidates,
	describeCandidate,
	findConfigured,
	isModelUnavailableError,
} from "../../extensions/auto-mode/model-select.ts";
import { modelIdentity } from "../../extensions/lib/model-policy.ts";

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

const pick = (available: any[], sessionModel: any, configured?: string, configuredSetForContainment?: string) =>
	classifierCandidates({ available, sessionModel, configured, configuredSetForContainment }).candidates;

const pickFull = (available: any[], sessionModel: any, configured?: string, configuredSetForContainment?: string) =>
	classifierCandidates({ available, sessionModel, configured, configuredSetForContainment });

describe("classifierCandidates: provider containment", () => {
	it("screens with the cheapest capable same-provider model", () => {
		// mini is the cheap tier; nano is tiny (excluded); gpt-5.5 is the session.
		const available = [
			model("openai", "gpt-5.5", 10),
			model("openai", "gpt-5-mini", 0.25),
			model("openai", "gpt-5-nano", 0.05),
		];
		const chain = pick(available, available[0]);
		expect(chain[0]).toMatchObject({ model: available[1], source: "economical" });
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

	it("crosses providers only when the user names one for THIS session", () => {
		// A cross-provider classifierModel is honored when it carries a stamp for the
		// current session (set via /auto-mode model) — naming a provider is choosing it.
		const session = model("ollama", "qwen3-coder");
		const available = [session, model("anthropic", "claude-haiku-4-5", 1)];
		const stamp = modelIdentity(session).containment;
		const result = pickFull(available, session, "anthropic/claude-haiku-4-5", stamp);
		expect(result.candidates[0].model.provider).toBe("anthropic");
		expect(result.candidates[0].source).toBe("configured");
		expect(result.notices.map((n) => n.text).join(" ")).toContain("honored");
	});

	it("overrides a stale cross-provider setting with a warning (subagent parity)", () => {
		// A hand-edited (unstamped) cross-provider classifierModel, or one stamped for
		// a since-left provider, is treated as stale: a same-provider model screens the
		// calls instead, and the user is told how to re-set it.
		const session = model("ollama", "qwen3-coder");
		const available = [session, model("anthropic", "claude-haiku-4-5", 1)];
		const result = pickFull(available, session, "anthropic/claude-haiku-4-5"); // no stamp
		expect(result.candidates.every((c) => c.source !== "configured")).toBe(true);
		expect(result.candidates[0].model.provider).toBe("ollama");
		expect(result.notices.map((n) => n.text).join(" ")).toContain("set for a different provider");
	});

	it("still ends the chain at the session model, so an explicit model failing is survivable", () => {
		const session = model("ollama", "qwen3-coder");
		const available = [session, model("anthropic", "claude-haiku-4-5", 1)];
		const stamp = modelIdentity(session).containment;
		const chain = pick(available, session, "anthropic/claude-haiku-4-5", stamp);
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

	it("screens with the session model when its vendor offers nothing cheaper and capable", () => {
		const available = [
			model("openrouter", "openai/gpt-5.1", 1.25),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
		];
		const chain = pick(available, model("openrouter", "openai/gpt-5.1", 1.25));
		expect(chain).toHaveLength(1);
		expect(chain[0].model.id).toBe("openai/gpt-5.1");
		expect(chain[0].source).toBe("session");
	});

	it("crosses vendors only on an explicit, stamped override", () => {
		const session = model("openrouter", "z-ai/glm-4.6", 0.5);
		const available = [session, model("openrouter", "openai/gpt-5-mini", 0.25)];
		const stamp = modelIdentity(session).containment;
		const chain = pick(available, session, "openrouter/openai/gpt-5-mini", stamp);
		expect(chain[0].model.id).toBe("openai/gpt-5-mini");
		expect(chain[0].source).toBe("configured");
	});
});

describe("classifierCandidates: tier preference (cheap → workhorse → frontier, never tiny)", () => {
	const anthropic = [
		model("anthropic", "claude-opus-4-8", 15), // frontier
		model("anthropic", "claude-sonnet-5", 3), // workhorse
		model("anthropic", "claude-haiku-4-5", 1), // cheap
	];

	it("screens an Opus session with Haiku (cheapest capable tier)", () => {
		const chain = pick(anthropic, anthropic[0]);
		expect(chain[0]).toMatchObject({ model: anthropic[2], source: "economical" });
	});

	it("screens a Sonnet session with Haiku too (cheap beats the session's own tier)", () => {
		const chain = pick(anthropic, anthropic[1]);
		expect(chain[0].model).toMatchObject({ id: "claude-haiku-4-5" });
	});

	it("screens a Haiku session with itself (nothing cheaper and capable)", () => {
		const chain = pick(anthropic, anthropic[2]);
		expect(chain[0].model).toMatchObject({ id: "claude-haiku-4-5" });
		expect(chain[0].source).toBe("session");
	});

	it("steps UP to workhorse when the provider has no cheap-tier model", () => {
		// Opus session, only a workhorse Sonnet is cheaper — no cheap tier available.
		const available = [model("anthropic", "claude-opus-4-8", 15), model("anthropic", "claude-sonnet-5", 3)];
		const chain = pick(available, available[0]);
		expect(chain[0]).toMatchObject({ model: available[1], source: "economical" });
	});

	it("never auto-selects a tiny-tier model — screens on the session model instead", () => {
		// nano is the only thing cheaper than the session, and it is tiny: too weak a
		// security boundary, so the session model screens rather than the tiny model.
		const available = [model("openai", "gpt-5.5", 10), model("openai", "gpt-5-nano", 0.05)];
		const chain = pick(available, available[0]);
		expect(chain).toHaveLength(1);
		expect(chain[0].source).toBe("session");
		expect(chain.every((c) => c.model.id !== "gpt-5-nano")).toBe(true);
	});

	it("prefers a cheap-tier model over a cheaper tiny one", () => {
		const available = [
			model("openai", "gpt-5.5", 10),
			model("openai", "gpt-5-mini", 0.25), // cheap
			model("openai", "gpt-5-nano", 0.05), // tiny, cheaper
		];
		const chain = pick(available, available[0]);
		expect(chain[0].model.id).toBe("gpt-5-mini");
		expect(chain.every((c) => c.model.id !== "gpt-5-nano")).toBe(true);
	});
});

describe("classifierCandidates: cost", () => {
	it("never selects a model more expensive than the session's own", () => {
		const available = [
			model("anthropic", "claude-haiku-4-5", 1),
			model("anthropic", "claude-fable-5", 15),
			model("anthropic", "claude-opus-5", 30),
		];
		const chain = pick(available, model("anthropic", "claude-fable-5", 15));
		for (const candidate of chain) {
			expect(candidate.model.cost?.input ?? 0, candidate.model.id).toBeLessThanOrEqual(15);
		}
		expect(chain[0].model.id).toBe("claude-haiku-4-5");
	});

	it("treats sentinel and zero prices as unpriced, not as cheap", () => {
		// pi carries -1000000 for OpenRouter's router pseudo-models and 0 for
		// free-tier entries; both would win a naive cheapest-first sort.
		const available = [
			model("openrouter", "openrouter/auto", -1000000),
			model("openrouter", "anthropic/free-thing", 0),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-fable-5", 15),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-fable-5", 15));
		for (const candidate of chain) {
			expect(candidate.model.id, candidate.model.id).not.toBe("openrouter/auto");
			expect(candidate.model.id, candidate.model.id).not.toBe("anthropic/free-thing");
		}
	});

	it("falls back to the session model when nothing in the provider is priced", () => {
		// A local setup: no cost data anywhere.
		const available = [model("ollama", "qwen3-coder"), model("ollama", "llama3")];
		const chain = pick(available, model("ollama", "qwen3-coder"));
		expect(chain).toHaveLength(1);
		expect(chain[0].source).toBe("session");
		expect(chain[0].model.id).toBe("qwen3-coder");
	});
});

describe("classifierCandidates: unsuitable variants", () => {
	it("never auto-selects a :batch model, however cheap", () => {
		// Batch endpoints are asynchronous — a blocking gate would wait out its
		// timeout — and they are systematically cheaper, so cost ranking prefers them.
		const available = [
			model("openrouter", "anthropic/claude-haiku-4.5:batch", 0.5),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
			model("openrouter", "anthropic/claude-fable-5", 3),
		];
		const chain = pick(available, model("openrouter", "anthropic/claude-fable-5", 3));
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
				model("openrouter", "openai/gpt-5.1", 5),
			];
			const chain = pick(available, model("openrouter", "openai/gpt-5.1", 5));
			for (const candidate of chain) {
				expect(candidate.model.id, `${suffix}: ${candidate.model.id}`).not.toContain(suffix);
			}
		}
	});

	it("honours an explicitly configured variant — naming it is choosing it", () => {
		const session = model("openrouter", "anthropic/claude-fable-5", 5);
		const available = [model("openrouter", "anthropic/claude-haiku-4.5:batch", 0.5), session];
		const stamp = modelIdentity(session).containment;
		const chain = pick(available, session, "openrouter/anthropic/claude-haiku-4.5:batch", stamp);
		expect(chain[0].source).toBe("configured");
		expect(chain[0].model.id).toBe("anthropic/claude-haiku-4.5:batch");
	});
});

describe("classifierCandidates: configured-model diagnostics", () => {
	it("warns and falls back when the configured model is not available", () => {
		const available = [model("anthropic", "claude-fable-5", 15), model("anthropic", "claude-haiku-4-5", 1)];
		const result = pickFull(available, model("anthropic", "claude-fable-5", 15), "anthropic/claude-opus-5");
		expect(result.candidates.every((c) => c.source !== "configured")).toBe(true);
		expect(result.notices.map((n) => n.text).join(" ")).toContain("not an available model");
	});

	it("honours a same-provider configured model with no cross-provider warning", () => {
		const available = [model("anthropic", "claude-fable-5", 15), model("anthropic", "claude-haiku-4-5", 1)];
		const result = pickFull(available, model("anthropic", "claude-fable-5", 15), "anthropic/claude-haiku-4-5");
		expect(result.candidates[0].source).toBe("configured");
		expect(result.candidates[0].model.id).toBe("claude-haiku-4-5");
		expect(result.notices).toHaveLength(0);
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
			"no cheaper capable model within",
		);
		expect(describeCandidate({ model: model("openai", "gpt-5-mini", 0.25), source: "economical" })).toContain(
			"cheapest capable model within",
		);
	});
});
