/**
 * A profile's provider entries (lib/profile/product-providers.ts): a provider
 * the product registers is its vendor's direct provider, a built-in host the
 * product vouches for counts its rows as the vendor's own, and an Anthropic
 * wire feature goes only to a provider whose entry lists it. With no entry
 * (One Code), nothing changes: a custom provider stays opaque and tiny.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { catalogModelFor } from "../../extensions/lib/models/model-catalog.ts";
import { pairedModel } from "../../extensions/lib/models/model-pairings.ts";
import { pinCatalog } from "./catalog-fixture.ts";
import { acceptsAnthropicWire, anthropicModelId, BUILTIN_PROVIDER_POLICIES, modelIdentity, providerPolicy } from "../../extensions/lib/models/model-policy.ts";
import { classifyModelTier, taskToolsEnabled } from "../../extensions/lib/models/model-tier.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { PROVIDER_VENDORS, type ProductProvider, WIRE_FEATURES } from "../../extensions/lib/profile/product-providers.ts";
import { activeProfile, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { supportsToolReferences } from "../../extensions/lib/request/deferred.ts";
import { clearThinkingEnabled } from "../../extensions/request/context-management/index.ts";
import { supportsToolAdditions } from "../../extensions/request/tool-search/tool-additions.ts";

const base = (): Profile => ({ features: {}, tools: {}, childExtensions: [], text: () => activeProfile().text });
const text = activeProfile().text;
const use = (providers: Record<string, ProductProvider>) =>
	setActiveProfileForTest(resolveProfile({ ...base(), text: () => text, providers }, {}, "/p"));
const model = (provider: string, id: string, extra: Partial<Model<Api>> = {}) =>
	({ provider, id, api: "anthropic-messages", baseUrl: "https://llm.example.test", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, ...extra }) as Model<Api>;
const tier = (m: Model<Api>) => classifyModelTier(m, {}).tier;

afterEach(() => setActiveProfileForTest(undefined));

describe("with no provider entry", () => {
	it("a custom provider stays opaque and tiny, whatever its ids say", () => {
		const m = model("acme", "claude-opus-5-5");
		expect(providerPolicy("acme").kind).toBe("opaque");
		expect(classifyModelTier(m, {})).toEqual({ tier: "tiny", reason: "custom provider, not in the catalogs" });
		expect(anthropicModelId(m)).toBeUndefined();
		for (const feature of WIRE_FEATURES) expect(acceptsAnthropicWire(m, feature), feature).toBe(false);
	});

	it("Claude on a built-in host is not Anthropic's own model", () => {
		expect(anthropicModelId(model("amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0"))).toBeUndefined();
		expect(tier(model("amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0"))).not.toBe("frontier");
	});

	it("Anthropic's own provider keeps every wire feature", () => {
		for (const feature of WIRE_FEATURES) expect(acceptsAnthropicWire(model("anthropic", "claude-opus-5-5"), feature), feature).toBe(true);
	});
});

describe("a provider the profile declares", () => {
	it("is its vendor's direct provider, tiered like Anthropic's own", () => {
		use({ acme: { serves: "anthropic" } });
		expect(providerPolicy("acme")).toEqual({ kind: "direct", profile: "anthropic" });
		expect(modelIdentity(model("acme", "claude-opus-5-5"))).toMatchObject({ containment: "acme", profile: "anthropic", confidence: "exact" });
		expect(classifyModelTier(model("acme", "claude-opus-5-5"), {})).toEqual({ tier: "frontier", reason: "anthropic frontier allowlist" });
		expect(tier(model("acme", "claude-sonnet-5-5"))).toBe("frontier");
		expect(tier(model("acme", "claude-sonnet-5"))).not.toBe("frontier");
		// Haiku takes the frontier forms for the prompt only, as on Anthropic's provider.
		expect(classifyModelTier(model("acme", "claude-haiku-5-5"), {}, "prompt").tier).toBe("frontier");
		expect(classifyModelTier(model("acme", "claude-haiku-5-5"), {}, "capability").tier).not.toBe("frontier");
		// Sonnet 5 runs without the task tools, as on Anthropic's provider.
		expect(taskToolsEnabled(model("acme", "claude-sonnet-5"), {}, "workhorse")).toBe(false);
		expect(taskToolsEnabled(model("other", "claude-sonnet-5"), {}, "workhorse")).toBe(true);
	});

	it("is matched in the catalog under its vendor, so the pairing table picks inside it", () => {
		pinCatalog([
			{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20] },
			{ id: "anthropic/claude-sonnet-5-5", released: "2026-09-28", price: [2, 10] },
			{ id: "anthropic/claude-haiku-5-5", released: "2026-10-07", price: [0.1, 0.5] },
		]);
		const row = (id: string, input: number) =>
			({ ...model("acme", id), name: id, contextWindow: 1_000_000, maxTokens: 64_000, input: ["text", "image"], cost: { input, output: input * 5 } }) as unknown as Model<Api>;
		const [opus, sonnet, haiku] = [row("claude-opus-5-5", 4), row("claude-sonnet-5-5", 2), row("claude-haiku-5-5", 0.1)];
		// Undeclared, the provider's ids match nothing and the table does not speak.
		expect(catalogModelFor(opus)).toBeUndefined();
		expect(pairedModel("classifier", [opus, sonnet, haiku], opus)).toBeUndefined();
		use({ acme: { serves: "anthropic" } });
		expect(catalogModelFor(opus)?.id).toBe("anthropic/claude-opus-5-5");
		expect(pairedModel("classifier", [opus, sonnet, haiku], opus)).toEqual({ kind: "model", model: sonnet });
		// Containment: a pick never leaves the session's provider for Anthropic's own.
		const direct = { ...sonnet, provider: "anthropic" } as Model<Api>;
		expect(pairedModel("classifier", [opus, direct, haiku], opus)).not.toEqual({ kind: "model", model: direct });
	});

	it("does not vouch for another vendor's ids on that provider", () => {
		use({ acme: { serves: "openai" } });
		expect(anthropicModelId(model("acme", "claude-opus-5-5"))).toBeUndefined();
		expect(tier(model("acme", "claude-opus-5-5"))).not.toBe("frontier");
	});

	it("counts a built-in host's rows of that vendor as the vendor's own, read through the host's ids", () => {
		use({ "amazon-bedrock": { serves: "anthropic" } });
		expect(providerPolicy("amazon-bedrock")).toEqual(BUILTIN_PROVIDER_POLICIES["amazon-bedrock"]);
		expect(anthropicModelId(model("amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0"))).toBe("claude-opus-5-5");
		expect(tier(model("amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0"))).toBe("frontier");
		expect(anthropicModelId(model("amazon-bedrock", "us.meta.llama-9-70b-v1:0"))).toBeUndefined();
	});

	it("gets only the wire features its entry lists", () => {
		use({ acme: { serves: "anthropic", wire: ["tool-references", "context-management"] } });
		const m = model("acme", "claude-sonnet-5-5", { compat: { supportsMidConvoToolChanges: true } as never });
		expect(supportsToolReferences(m as never)).toBe(true);
		expect(supportsToolReferences(model("acme", "claude-haiku-4-0") as never)).toBe(false);
		expect(clearThinkingEnabled(undefined, m as never)).toBe(true);
		expect(clearThinkingEnabled("0", m as never)).toBe(false);
		expect(acceptsAnthropicWire(m, "system-role")).toBe(false);
		expect(supportsToolAdditions(m)).toBe(false);
		use({ acme: { serves: "anthropic" } });
		expect(supportsToolReferences(m as never)).toBe(false);
		expect(clearThinkingEnabled(undefined, m as never)).toBe(false);
	});

	it("leaves Anthropic's own provider behind its own host check for context management", () => {
		use({ acme: { serves: "anthropic", wire: ["context-management"] } });
		expect(clearThinkingEnabled(undefined, model("anthropic", "claude-opus-5-5", { baseUrl: "https://proxy.example.test" }) as never)).toBe(false);
		expect(clearThinkingEnabled(undefined, model("anthropic", "claude-opus-5-5", { baseUrl: "https://api.anthropic.com" }) as never)).toBe(true);
	});
});

describe("provider entries at load", () => {
	const load = (providers: Record<string, unknown>) => () => resolveProfile({ ...base(), text: () => text, providers: providers as never }, {}, "/p");

	it("names every vendor as a built-in direct provider's profile", () => {
		const profiles = new Set(Object.values(BUILTIN_PROVIDER_POLICIES).filter((policy) => policy.kind === "direct").map((policy) => policy.profile));
		for (const vendor of PROVIDER_VENDORS) expect(profiles.has(vendor), vendor).toBe(true);
	});

	it("refuses an entry the base cannot read", () => {
		expect(load({ anthropic: { serves: "anthropic" } })).toThrow(/provider "anthropic" is the base's own/);
		expect(load({ acme: { serves: "claude" } })).toThrow(/provider "acme" serves an unknown vendor "claude"/);
		expect(load({ acme: { serves: "anthropic", wire: ["web"] } })).toThrow(/unknown wire feature "web"/);
		expect(load({ acme: { serves: "openai", wire: ["system-role"] } })).toThrow(/lists wire features but does not serve anthropic/);
	});
});
