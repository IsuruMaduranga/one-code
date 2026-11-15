import { describe, expect, it } from "vitest";
import { cacheWarmingVeto, userCacheWarmingMode } from "../../extensions/lib/request/cache-warming.ts";

describe("cacheWarmingVeto", () => {
	it("stops a warm pi decides while the session is idle on pi's default (pi 1.5.1's idle warming)", () => {
		expect(cacheWarmingVeto(true, undefined)).toEqual({ action: "stop" });
	});

	it("leaves a warm during a run to pi's own decision", () => {
		expect(cacheWarmingVeto(false, undefined)).toBeUndefined();
	});

	it("leaves every warm to pi when the user set cacheWarming", () => {
		for (const mode of ["idle", "streaming", "off"]) expect(cacheWarmingVeto(true, mode)).toBeUndefined();
	});
});

describe("userCacheWarmingMode", () => {
	it("reads a mode pi accepts from the global settings", () => {
		expect(userCacheWarmingMode({ cacheWarming: "idle" })).toBe("idle");
		expect(userCacheWarmingMode({ cacheWarming: "off" })).toBe("off");
	});

	it("treats an unset or unknown value as unset, as pi does", () => {
		expect(userCacheWarmingMode({})).toBeUndefined();
		expect(userCacheWarmingMode(undefined)).toBeUndefined();
		expect(userCacheWarmingMode({ cacheWarming: "always" })).toBeUndefined();
		expect(userCacheWarmingMode({ cacheWarming: 3 })).toBeUndefined();
	});
});
