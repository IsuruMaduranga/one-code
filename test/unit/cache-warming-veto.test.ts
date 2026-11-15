import { describe, expect, it } from "vitest";
import { cacheWarmingVeto } from "../../extensions/lib/request/cache-warming.ts";

describe("cacheWarmingVeto", () => {
	it("stops a warm pi decides while the session is idle (pi 1.5.1's idle warming)", () => {
		expect(cacheWarmingVeto(true)).toEqual({ action: "stop" });
	});

	it("leaves a warm during a run to pi's own decision", () => {
		expect(cacheWarmingVeto(false)).toBeUndefined();
	});
});
