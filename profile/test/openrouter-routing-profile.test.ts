import { describe, expect, it } from "vitest";
import { openRouterRoutingProblems } from "../../extensions/lib/profile/openrouter-routing.ts";
import { profile } from "../index.ts";

describe("One Code's OpenRouter routing defaults", () => {
	it("keep fp4 hosts off the measured vendors' models, and keep the endpoints that declare no precision", () => {
		const floor = ["fp8", "bf16", "fp16", "fp32", "unknown"];
		expect(profile.openRouterRouting).toEqual({ deepseek: { quantizations: floor }, qwen: { quantizations: floor } });
		expect(openRouterRoutingProblems(profile.openRouterRouting ?? {})).toEqual([]);
	});
});
