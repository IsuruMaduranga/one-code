import { describe, expect, it } from "vitest";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { activeOpenRouterRouting, openRouterRoutingDefaultsEnabled, routingFloorFailureHint, withOpenRouterRoutingDefaults, withRoutingDefaults } from "../../extensions/lib/request/openrouter-routing-defaults.ts";
import { type OpenRouterRoutingDefault, openRouterRoutingProblems } from "../../extensions/lib/profile/openrouter-routing.ts";
import { adjustsOpenRouter, openRouterAdjust } from "../../extensions/request/cache-marks/openrouter-adjust.ts";
import { openRouterRegistration } from "../../extensions/lib/request/anthropic-stream.ts";
import { resolveProfile } from "../../extensions/lib/profile/profile.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { profile as shippedProfile } from "./helpers/default-profile.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";

const FLOOR = ["fp8", "bf16", "fp16", "fp32", "unknown"];
const table = new Map<string, OpenRouterRoutingDefault>([["deepseek", { quantizations: FLOOR }]]);
const model = (id: string, compat: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, api: "openai-completions", provider: "openrouter", compat, ...extra });

describe("withRoutingDefaults", () => {
	it("adds the floor when the user set no routing, or routing that does not choose hosts", () => {
		expect(withRoutingDefaults(undefined, { quantizations: FLOOR })).toEqual({ quantizations: FLOOR });
		expect(withRoutingDefaults({ ignore: ["deepinfra"], sort: "price" }, { quantizations: FLOOR })).toEqual({ ignore: ["deepinfra"], sort: "price", quantizations: FLOOR });
	});

	it("leaves the user's routing alone when it sets quantizations, only or order", () => {
		for (const routing of [{ quantizations: ["fp4"] }, { only: ["wafer"] }, { order: ["open-inference"], allow_fallbacks: false }]) {
			expect(withRoutingDefaults(routing, { quantizations: FLOOR }), JSON.stringify(routing)).toBe(routing);
		}
	});

	it("copies the list, so a request never shares the profile's array", () => {
		const defaults = { quantizations: FLOOR };
		const next = withRoutingDefaults(undefined, defaults)!;
		expect(next.quantizations).not.toBe(defaults.quantizations);
	});
});

describe("withOpenRouterRoutingDefaults", () => {
	it("sets the floor on a listed vendor's OpenRouter Chat Completions models, aliases included, without touching the original", () => {
		for (const id of ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-1017", "~deepseek/deepseek-flash-latest"]) {
			const original = model(id, { thinkingFormat: "openrouter" });
			expect(withOpenRouterRoutingDefaults(original, table).compat, id).toEqual({ thinkingFormat: "openrouter", openRouterRouting: { quantizations: FLOOR } });
			expect(original.compat).toEqual({ thinkingFormat: "openrouter" });
		}
	});

	it("leaves an unlisted vendor alone", () => {
		for (const id of ["qwen/qwen3.8-27b", "z-ai/glm-5.3-flash", "deepseekish/model"]) {
			const original = model(id);
			expect(withOpenRouterRoutingDefaults(original, table), id).toBe(original);
		}
	});

	it("never touches OpenRouter's Anthropic models, another provider, or an empty table", () => {
		const anthropic = model("anthropic/claude-haiku-4.5", {}, { api: "anthropic-messages" });
		expect(withOpenRouterRoutingDefaults(anthropic, new Map([["anthropic", { quantizations: FLOOR }]]))).toBe(anthropic);
		const direct = model("deepseek-v4.1-flash", {}, { provider: "deepseek" });
		expect(withOpenRouterRoutingDefaults(direct, table)).toBe(direct);
		const listed = model("deepseek/deepseek-v4.1-flash");
		expect(withOpenRouterRoutingDefaults(listed, new Map())).toBe(listed);
	});

	it("lets the routing a user's models.json put on the model win", () => {
		const pinned = model("deepseek/deepseek-v4.1-flash", { openRouterRouting: { only: ["inference-net"] } });
		expect(withOpenRouterRoutingDefaults(pinned, table)).toBe(pinned);
		const ignoring = model("deepseek/deepseek-v4.1-flash", { openRouterRouting: { ignore: ["morph"] } });
		expect(withOpenRouterRoutingDefaults(ignoring, table).compat).toEqual({ openRouterRouting: { ignore: ["morph"], quantizations: FLOOR } });
	});
});

describe("openRouterAdjust", () => {
	const on = { marks: true, ignore: true, routing: table };

	it("composes the marks, the skipped host and the floor in that order", () => {
		const adjusted = openRouterAdjust(on)(model("deepseek/deepseek-v4.1-flash", { thinkingFormat: "openrouter" }));
		expect(adjusted.compat).toEqual({ thinkingFormat: "openrouter", cacheControlFormat: "anthropic", openRouterRouting: { ignore: ["open-inference"], quantizations: FLOOR } });
	});

	it("gives one model the same routing bytes on every call, from the registry's object or a copy of it", () => {
		const adjust = openRouterAdjust(on);
		const original = model("deepseek/deepseek-v4.1-flash", { thinkingFormat: "openrouter" });
		const bytes = [original, { ...original }, structuredClone(original), original].map((m) => JSON.stringify((adjust(m).compat as Record<string, unknown>).openRouterRouting));
		expect(new Set(bytes).size).toBe(1);
		expect(bytes[0]).toBe('{"ignore":["open-inference"],"quantizations":["fp8","bf16","fp16","fp32","unknown"]}');
	});

	it("registers while only the routing defaults are on, and adds nothing when they are off", () => {
		expect(adjustsOpenRouter({ marks: false, ignore: false, routing: table })).toBe(true);
		expect(adjustsOpenRouter({ marks: false, ignore: false, routing: new Map() })).toBe(false);
		const m = model("deepseek/deepseek-v4.1-flash");
		expect(openRouterAdjust({ marks: false, ignore: false, routing: new Map() })(m)).toBe(m);
		expect(openRouterAdjust({ marks: false, ignore: false, routing: table })(m).compat).toEqual({ openRouterRouting: { quantizations: FLOOR } });
	});

	it("reaches the request body as provider, through pi-ai's own Chat Completions build", async () => {
		const deepseek = getModels("openrouter").find((m) => m.id === "deepseek/deepseek-v4.1-flash") as Model<Api>;
		expect(deepseek.api).toBe("openai-completions");
		const registration = openRouterRegistration(openRouterAdjust(on))!;
		const bodies: unknown[] = [];
		for (let i = 0; i < 2; i++) {
			const stream = registration.streamSimple(deepseek, { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {
				apiKey: "test-key",
				onPayload: (payload: unknown) => {
					bodies.push((payload as { provider?: unknown }).provider);
					throw new Error("stop before sending");
				},
			});
			for await (const _event of stream) {
				// Drain to the error event the thrown hook ends it with.
			}
		}
		expect(bodies).toEqual([
			{ ignore: ["open-inference"], quantizations: FLOOR },
			{ ignore: ["open-inference"], quantizations: FLOOR },
		]);
	});
});

describe("routingFloorFailureHint", () => {
	const refusal = '404 {"error":{"message":"No allowed providers are available for the selected model.","code":404}}';

	it("names the cause, the off switch and the models.json override when the floor left the model no host", () => {
		const hint = routingFloorFailureHint(model("deepseek/deepseek-v4.1-flash"), refusal, table);
		expect(hint).toContain("no host that serves deepseek/deepseek-v4.1-flash at the precisions");
		expect(hint).toContain("(fp8, bf16, fp16, fp32, unknown)");
		expect(hint).toContain(`${envName("OPENROUTER_ROUTING_DEFAULTS")}=0`);
		expect(hint).toContain("compat.openRouterRouting for this model in pi's models.json");
	});

	it("says nothing for another error, or for a model the floor did not reach", () => {
		expect(routingFloorFailureHint(model("deepseek/deepseek-v4.1-flash"), "429 rate limited", table)).toBeUndefined();
		expect(routingFloorFailureHint(model("deepseek/deepseek-v4.1-flash"), undefined, table)).toBeUndefined();
		expect(routingFloorFailureHint(model("z-ai/glm-5.3"), refusal, table)).toBeUndefined();
		expect(routingFloorFailureHint(model("deepseek/deepseek-v4.1-flash", { openRouterRouting: { only: ["relace"] } }), refusal, table)).toBeUndefined();
		expect(routingFloorFailureHint(model("deepseek/deepseek-v4.1-flash"), refusal, new Map())).toBeUndefined();
		expect(routingFloorFailureHint(model("anthropic/claude-haiku-4.5", {}, { api: "anthropic-messages" }), refusal, new Map([["anthropic", { quantizations: FLOOR }]]))).toBeUndefined();
	});

	it("reads no table while the switch is off", () => {
		expect(activeOpenRouterRouting({ [envName("OPENROUTER_ROUTING_DEFAULTS")]: "0" }).size).toBe(0);
	});
});

describe("openRouterRoutingDefaultsEnabled", () => {
	it("is on by default and off only with its own switch at 0", () => {
		const own = envName("OPENROUTER_ROUTING_DEFAULTS");
		expect(openRouterRoutingDefaultsEnabled({})).toBe(true);
		expect(openRouterRoutingDefaultsEnabled({ [own]: "1" })).toBe(true);
		expect(openRouterRoutingDefaultsEnabled({ [envName("OPENROUTER_IGNORE_HOSTS")]: "0" })).toBe(true);
		expect(openRouterRoutingDefaultsEnabled({ [own]: "0" })).toBe(false);
	});
});

describe("the profile's openRouterRouting", () => {
	const empty: Profile = { features: {}, tools: {}, childExtensions: [], text: shippedProfile.text };

	it("accepts a floor of OpenRouter's quantizations per vendor", () => {
		expect(openRouterRoutingProblems({ deepseek: { quantizations: FLOOR }, "z-ai": { quantizations: ["bf16"] } })).toEqual([]);
		const resolved = resolveProfile({ ...empty, openRouterRouting: { qwen: { quantizations: FLOOR } } }, {}, "/p");
		expect([...resolved.openRouterRouting]).toEqual([["qwen", { quantizations: FLOOR }]]);
		expect(resolveProfile(empty, {}, "/p").openRouterRouting.size).toBe(0);
	});

	it("names every problem: a vendor spelled as a model id, an unknown field, an empty or unknown list, a duplicate", () => {
		const problems = openRouterRoutingProblems({
			"deepseek/deepseek-v4.1-flash": { quantizations: FLOOR },
			"~qwen": { quantizations: FLOOR },
			qwen: { quantisations: FLOOR },
			"z-ai": { quantizations: [] },
			minimax: { quantizations: ["fp8", "mxfp4", 16] },
			moonshotai: { quantizations: ["fp8", "fp8"] },
			xiaomi: ["fp8"],
		});
		expect(problems).toEqual([
			'openRouterRouting "deepseek/deepseek-v4.1-flash" is not a model-id vendor (the lowercase part before the slash, such as "deepseek")',
			'openRouterRouting "~qwen" is not a model-id vendor (the lowercase part before the slash, such as "deepseek")',
			'openRouterRouting "qwen" has an unknown field "quantisations"',
			'openRouterRouting "qwen" needs a non-empty "quantizations" list',
			'openRouterRouting "z-ai" needs a non-empty "quantizations" list',
			'openRouterRouting "minimax" lists "mxfp4", 16, which OpenRouter does not take (one of int4, int8, fp4, fp6, fp8, fp16, bf16, fp32, unknown)',
			'openRouterRouting "moonshotai" lists a quantization twice',
			'openRouterRouting "xiaomi" must be an object with a "quantizations" list',
		]);
	});

	it("refuses an invalid table at load", () => {
		expect(() => resolveProfile({ ...empty, openRouterRouting: { qwen: { quantizations: ["fp9"] } } }, {}, "/p")).toThrow(/Invalid profile: openRouterRouting "qwen" lists "fp9"/);
	});
});
