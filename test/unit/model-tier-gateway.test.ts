/**
 * The frontier rule on gateways and Google's frontier rule
 * (working-docs/decisions/model-tiers.md, 2026-11-17): a frontier lab's model
 * on a known gateway passes the lab's version gate as on the lab's own
 * provider, for both the prompt register and the capability tier, while the
 * Anthropic wire features stay first-party. Every gateway row of pi's real
 * catalog is checked, so a pi bump that adds or respells one shows up here.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifierCandidates } from "../../extensions/lib/models/classifier-model.ts";
import { bundledSources, setCatalogSourcesForTest } from "../../extensions/lib/models/model-catalog-data.ts";
import { acceptsAnthropicWire, anthropicModelId, modelIdentity, modelSpec } from "../../extensions/lib/models/model-policy.ts";
import { classifyModelTier, intrinsicTier, resolveModelTier, usesClaudeCodeFastPaths } from "../../extensions/lib/models/model-tier.ts";
import { resolveSubagentModel } from "../../extensions/lib/models/subagent-model.ts";
import { WIRE_FEATURES } from "../../extensions/lib/profile/product-providers.ts";

const noEnv = {} as NodeJS.ProcessEnv;
const GATEWAYS = ["openrouter", "vercel-ai-gateway", "cloudflare-ai-gateway"];
const LABS = new Set(["anthropic", "openai", "google"]);

let catalog: Model<Api>[] = [];
beforeAll(async () => {
	// pi's generated catalog is not on pi-ai's export map; read it from the repo's node_modules (as model-tier-catalog.test.ts does).
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const { MODELS } = (await import(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js"))) as {
		MODELS: Record<string, Record<string, Model<Api>>>;
	};
	catalog = Object.values(MODELS).flatMap((rows) => Object.values(rows));
});
beforeEach(() => setCatalogSourcesForTest(bundledSources()));

const row = (spec: string): Model<Api> => {
	const found = catalog.find((model) => modelSpec(model) === spec);
	if (!found) throw new Error(`${spec} is not in pi's catalog`);
	return found;
};
/** A hand-built row: pi's catalog does not list the id (yet). */
const built = (provider: string, id: string, from: string, cost?: Partial<Model<Api>["cost"]>): Model<Api> => {
	const base = row(from);
	return { ...base, provider, id, name: id, cost: { ...base.cost, ...cost } };
};

/** The gateway rows of pi's catalog that pass their lab's version gate. Everything else a gateway lists from these labs does not. */
const GATEWAY_FRONTIER = new Set([
	...["5", "5.1", "5.2"].map((v) => `openrouter/anthropic/claude-fable-${v}`),
	...["4.8", "5", "5.5"].map((v) => `openrouter/anthropic/claude-opus-${v}`),
	"openrouter/anthropic/claude-sonnet-5.5",
	...["gpt-6-astra", "gpt-6-astra-pro", "gpt-6-sol", "gpt-6-sol-pro", "gpt-6.1-sol", "gpt-6.1-sol-pro"].map((id) => `openrouter/openai/${id}`),
	...["fable-5", "fable-5.1", "fable-5.2", "fable-5.2-fast", "opus-4.8", "opus-4.8-fast", "opus-5", "opus-5-fast", "opus-5.5", "opus-5.5-fast", "sonnet-5.5"].map(
		(id) => `vercel-ai-gateway/anthropic/claude-${id}`,
	),
	...["gpt-6-astra", "gpt-6-astra-fast", "gpt-6-sol", "gpt-6-sol-fast", "gpt-6.1-sol", "gpt-6.1-sol-fast"].map((id) => `vercel-ai-gateway/openai/${id}`),
	...["claude-fable-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"].map(
		(id) => `cloudflare-ai-gateway/${id}`,
	),
]);

const labRows = () => catalog.filter((model) => GATEWAYS.includes(model.provider) && LABS.has(modelIdentity(model).profile ?? ""));

describe("frontier on a known gateway", () => {
	it("lists every expected row in pi's catalog", () => {
		for (const spec of GATEWAY_FRONTIER) expect(() => row(spec), spec).not.toThrow();
	});

	it("puts exactly the version-gated rows of each gateway in frontier, for the prompt and the capability tier alike", () => {
		const rows = labRows();
		expect(rows.length).toBeGreaterThan(100);
		for (const model of rows) {
			const spec = modelSpec(model);
			const frontier = GATEWAY_FRONTIER.has(spec);
			expect(intrinsicTier(model) === "frontier", spec).toBe(frontier);
			// Haiku 5.5 aside (below), the prompt tier is the capability tier.
			if (!/claude-haiku-5/.test(model.id)) expect(resolveModelTier(model, noEnv) === "frontier", spec).toBe(frontier);
			if (frontier) expect(classifyModelTier(model, noEnv).reason).toMatch(/^(anthropic|openai) frontier allowlist \(gateway\)$/);
		}
	});

	it("rewrites Anthropic's dotted gateway version and parses Vercel's -fast suffix", () => {
		expect(classifyModelTier(row("openrouter/anthropic/claude-sonnet-5.5"), noEnv)).toEqual({ tier: "frontier", reason: "anthropic frontier allowlist (gateway)" });
		expect(intrinsicTier(row("vercel-ai-gateway/anthropic/claude-opus-5.5-fast"))).toBe("frontier");
		// Opus 4.7, Sonnet 5 and Opus 4.1 keep their catalog tier, dotted or not.
		for (const spec of ["openrouter/anthropic/claude-opus-4.7", "openrouter/anthropic/claude-sonnet-5", "openrouter/anthropic/claude-opus-4.1", "cloudflare-ai-gateway/claude-opus-4-7"]) {
			expect(intrinsicTier(row(spec)), spec).not.toBe("frontier");
		}
	});

	it("reads an endpoint variant as its base id, and a dated id by its version", () => {
		const sonnet = row("openrouter/anthropic/claude-sonnet-5.5");
		for (const id of ["anthropic/claude-sonnet-5.5:thinking", "anthropic/claude-sonnet-5.5:online", "anthropic/claude-sonnet-5.5:free"]) {
			expect(intrinsicTier({ ...sonnet, id }), id).toBe("frontier");
		}
		expect(intrinsicTier({ ...sonnet, id: "anthropic/claude-opus-4.8-20260101" })).toBe("frontier");
		expect(intrinsicTier({ ...sonnet, id: "anthropic/claude-sonnet-4.5-20250929" })).not.toBe("frontier");
	});

	it("refuses moving aliases and batch endpoints on purpose", () => {
		for (const spec of [
			"openrouter/~anthropic/claude-opus-latest",
			"openrouter/~anthropic/claude-fable-latest",
			"openrouter/~openai/gpt-sol-latest",
			"openrouter/~google/gemini-pro-latest",
			"openrouter/anthropic/claude-opus-5.5:batch",
			"openrouter/openai/gpt-6.1-sol:batch",
			"vercel-ai-gateway/anthropic/claude-opus-5.5-batch",
			"vercel-ai-gateway/openai/gpt-6-astra-batch",
		]) {
			expect(intrinsicTier(row(spec)), spec).not.toBe("frontier");
			expect(resolveModelTier(row(spec), noEnv), spec).not.toBe("frontier");
		}
	});

	it("gives a gateway Haiku 5.5 the frontier prompt forms and keeps its catalog tier for capability", () => {
		for (const spec of ["openrouter/anthropic/claude-haiku-5.5", "vercel-ai-gateway/anthropic/claude-haiku-5.5", "cloudflare-ai-gateway/claude-haiku-5-5"]) {
			expect(classifyModelTier(row(spec), noEnv), spec).toEqual({ tier: "frontier", reason: "anthropic frontier allowlist (prompt and tool forms, gateway)" });
			expect(intrinsicTier(row(spec)), spec).toBe("cheap");
		}
		expect(resolveModelTier(row("openrouter/anthropic/claude-haiku-4.5"), noEnv)).not.toBe("frontier");
	});

	it("leaves hosted, opaque and custom providers as they were: an `anthropic/` id proves nothing there", () => {
		const sonnet = row("openrouter/anthropic/claude-sonnet-5.5");
		for (const model of [
			{ ...sonnet, provider: "my-proxy" },
			{ ...sonnet, provider: "my-proxy", id: "claude-opus-5-5" },
			row("opencode/claude-opus-5-5"),
			row("radius/claude-opus-5-5"),
			row("amazon-bedrock/us.anthropic.claude-opus-5-5"),
			row("github-copilot/claude-opus-5.5"),
			row("github-copilot/gpt-6-sol"),
		]) {
			expect(resolveModelTier(model, noEnv), modelSpec(model)).not.toBe("frontier");
		}
	});

	it("does not widen Anthropic's wire features to any gateway row", () => {
		for (const model of labRows()) {
			expect(anthropicModelId(model), modelSpec(model)).toBeUndefined();
			for (const feature of WIRE_FEATURES) expect(acceptsAnthropicWire(model, feature), `${modelSpec(model)} ${feature}`).toBe(false);
		}
	});

	it("keeps Claude Code's fast paths for every row it moves, as workhorse had them", () => {
		for (const spec of GATEWAY_FRONTIER) expect(usesClaudeCodeFastPaths(row(spec)), spec).toBe(true);
	});
});

describe("Google's frontier rule", () => {
	// pi's catalog has only Gemini 4 Argon of the Gemini 4 line; Carbon and Hydrogen are built from its record.
	it("admits Gemini 4 Carbon and Hydrogen and later majors on Google's own providers", () => {
		for (const provider of ["google", "google-vertex"]) {
			for (const id of ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4.1-carbon", "gemini-5-hydrogen", "gemini-4-carbon-preview"]) {
				const model = built(provider, id, `${provider}/gemini-4-argon`);
				expect(classifyModelTier(model, noEnv), `${provider}/${id}`).toEqual({ tier: "frontier", reason: "google frontier allowlist" });
				expect(intrinsicTier(model)).toBe("frontier");
			}
		}
	});

	it("admits them through a gateway too", () => {
		expect(classifyModelTier(built("openrouter", "google/gemini-4-carbon", "openrouter/google/gemini-4-argon"), noEnv)).toEqual({ tier: "frontier", reason: "google frontier allowlist (gateway)" });
		expect(intrinsicTier(built("vercel-ai-gateway", "google/gemini-4-hydrogen", "vercel-ai-gateway/google/gemini-4-argon"))).toBe("frontier");
		expect(intrinsicTier(built("openrouter", "google/gemini-4-carbon:batch", "openrouter/google/gemini-4-argon"))).not.toBe("frontier");
	});

	it("keeps Gemini 4 Argon, the Flash lines and another vendor's Gemini row at their catalog tier", () => {
		for (const spec of ["google/gemini-4-argon", "google-vertex/gemini-4-argon", "openrouter/google/gemini-4-argon", "vercel-ai-gateway/google/gemini-4-argon", "google/gemini-3.8-flash", "openrouter/google/gemini-3.8-flash"]) {
			expect(resolveModelTier(row(spec), noEnv), spec).not.toBe("frontier");
		}
		expect(resolveModelTier(built("google", "gemini-5-flash", "google/gemini-3.8-flash"), noEnv)).not.toBe("frontier");
		expect(resolveModelTier(built("google", "gemini-3-carbon", "google/gemini-4-argon"), noEnv)).not.toBe("frontier");
		// Azure serves other vendors' models, but it is not Google's provider.
		expect(resolveModelTier(built("azure", "gemini-4-carbon", "google/gemini-4-argon"), noEnv)).not.toBe("frontier");
		// Cloudflare names a lab only by API route, and its OpenAI-compatible route serves several vendors.
		expect(resolveModelTier(built("cloudflare-ai-gateway", "gemini-4-carbon", "cloudflare-ai-gateway/gpt-6.1-sol"), noEnv)).not.toBe("frontier");
		// GitHub Copilot is a host, not a gateway.
		expect(resolveModelTier(built("github-copilot", "gemini-4-carbon", "github-copilot/gemini-4-argon"), noEnv)).not.toBe("frontier");
	});
});

describe("the auto-mode classifier for a gateway frontier session", () => {
	const chain = (sessionModel: Model<Api>, extra: Model<Api>[] = []) => {
		const result = classifierCandidates({ available: [...catalog, ...extra], sessionModel });
		return { candidates: result.candidates.map((c) => `${modelSpec(c.model)} ${c.source}`), notices: result.notices, fallback: result.fallback?.reason };
	};

	it("pairs OpenRouter's Sonnet 5.5 with Haiku 5.5, with no notice", () => {
		expect(chain(row("openrouter/anthropic/claude-sonnet-5.5"))).toEqual({
			candidates: ["openrouter/anthropic/claude-haiku-5.5 paired", "openrouter/anthropic/claude-sonnet-5.5 session"],
			notices: [],
			fallback: undefined,
		});
	});

	it("pairs OpenRouter's GPT-6.1 Sol with GPT-6.1 Terra, with no notice", () => {
		expect(chain(row("openrouter/openai/gpt-6.1-sol"))).toEqual({
			candidates: ["openrouter/openai/gpt-6.1-terra paired", "openrouter/openai/gpt-6.1-sol session"],
			notices: [],
			fallback: undefined,
		});
	});

	it("keeps Gemini 4 Carbon as its own classifier on Google's provider, silently", () => {
		const carbon = built("google", "gemini-4-carbon", "google/gemini-4-argon", { input: 2, output: 10 });
		const hydrogen = built("google", "gemini-4-hydrogen", "google/gemini-4-argon", { input: 1.5, output: 7.5 });
		expect(chain(carbon, [carbon, hydrogen])).toEqual({ candidates: ["google/gemini-4-carbon session"], notices: [], fallback: "paired-session" });
	});
});

describe("small variants of a frontier line", () => {
	// No catalog lists these today; the gate must not depend on that.
	const cases: [string, string, string][] = [
		["openrouter", "openai/gpt-6-sol-nano", "openrouter/openai/gpt-6-sol"],
		["openai", "gpt-6-sol-nano", "openai/gpt-6-sol"],
		["openai", "gpt-6-astra-mini", "openai/gpt-6-astra"],
		["openrouter", "google/gemini-4-hydrogen-lite", "openrouter/google/gemini-4-argon"],
		["google", "gemini-4-hydrogen-lite", "google/gemini-4-argon"],
		["google", "gemini-4-carbon-flash", "google/gemini-4-argon"],
		["vercel-ai-gateway", "google/gemini-4-carbon-flash", "vercel-ai-gateway/google/gemini-4-argon"],
		["openrouter", "anthropic/claude-sonnet-5.5-mini", "openrouter/anthropic/claude-sonnet-5.5"],
		["anthropic", "claude-sonnet-5-5-mini", "anthropic/claude-sonnet-5-5"],
		["anthropic", "claude-haiku-5-5-nano", "anthropic/claude-haiku-5-5"],
		["openrouter", "openai/gpt-6-sol-20b", "openrouter/openai/gpt-6-sol"],
	];

	it("are never frontier, for the prompt or the capability tier, on a gateway or the lab's own provider", () => {
		for (const [provider, id, from] of cases) {
			const model = built(provider, id, from);
			expect(resolveModelTier(model, noEnv), `${provider}/${id}`).not.toBe("frontier");
			expect(intrinsicTier(model), `${provider}/${id}`).not.toBe("frontier");
		}
	});

	it("keeps -pro, -fast, -preview and dated ids admitted", () => {
		for (const [provider, id, from] of [
			["openai", "gpt-6.1-sol-pro", "openai/gpt-6.1-sol"],
			["openrouter", "openai/gpt-6-astra-fast", "openrouter/openai/gpt-6-astra"],
			["google", "gemini-4-carbon-preview", "google/gemini-4-argon"],
			["anthropic", "claude-opus-5-5-20261101", "anthropic/claude-opus-5-5"],
			["openrouter", "anthropic/claude-opus-5.5-fast", "openrouter/anthropic/claude-opus-5.5"],
		]) {
			expect(intrinsicTier(built(provider, id, from)), `${provider}/${id}`).toBe("frontier");
		}
	});
});

describe("every gateway row the frontier rule lifts keeps a paired classifier and no visible notice", () => {
	it("pairs each one through the table (a -pro or -fast SKU like its base line), or keeps the session silently where the table says so", () => {
		const unpaired: string[] = [];
		for (const spec of GATEWAY_FRONTIER) {
			const result = classifierCandidates({ available: catalog, sessionModel: row(spec) });
			expect(result.notices, spec).toEqual([]);
			const head = result.candidates[0];
			if (result.fallback) expect(result.fallback.reason, spec).toBe("paired-session");
			else if (head?.source !== "paired") unpaired.push(spec);
		}
		// The table names no row for these lines (Fable 5, Opus 4.8): the cost algorithm picks, silently, as before the rule.
		expect(unpaired.sort()).toEqual(
			[
				"cloudflare-ai-gateway/claude-fable-5",
				"cloudflare-ai-gateway/claude-opus-4-8",
				"openrouter/anthropic/claude-fable-5",
				"openrouter/anthropic/claude-opus-4.8",
				"vercel-ai-gateway/anthropic/claude-fable-5",
				"vercel-ai-gateway/anthropic/claude-opus-4.8",
				"vercel-ai-gateway/anthropic/claude-opus-4.8-fast",
			].sort(),
		);
	});

	it("gives a -pro or -fast OpenAI SKU its base line's classifier and subagent default", () => {
		const head = (spec: string) => modelSpec(classifierCandidates({ available: catalog, sessionModel: row(spec) }).candidates[0].model);
		expect(head("openrouter/openai/gpt-6.1-sol-pro")).toBe("openrouter/openai/gpt-6.1-terra");
		expect(head("openrouter/openai/gpt-6-sol-pro")).toBe("openrouter/openai/gpt-6.1-terra");
		expect(head("openrouter/openai/gpt-6-astra-pro")).toBe("openrouter/openai/gpt-6.1-sol");
		expect(head("vercel-ai-gateway/openai/gpt-6-astra-fast")).toBe("vercel-ai-gateway/openai/gpt-6.1-sol");
		for (const spec of ["openrouter/openai/gpt-6-sol-pro", "openrouter/openai/gpt-6-astra-pro", "vercel-ai-gateway/openai/gpt-6-astra-fast", "openrouter/openai/gpt-6.1-sol-pro"]) {
			const resolved = resolveSubagentModel({ sessionModel: row(spec), available: catalog });
			expect(resolved.model && modelSpec(resolved.model), spec).toBe(`${spec.slice(0, spec.indexOf("/openai/"))}/openai/gpt-6.1-terra`);
		}
	});
});
