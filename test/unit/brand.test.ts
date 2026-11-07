import { join } from "node:path";
import { describe, expect, it } from "vitest";
import data from "../../profile/brand.json" with { type: "json" };
import { type Brand, brand, brandedId, checkBrand, envName, productStateDir } from "../../extensions/lib/brand.mjs";

// The typecheck's proof that the shipped brand is complete.
data satisfies Brand;

describe("brand", () => {
	it("derives ids, environment names and the state dir from the profile's brand", () => {
		expect(brandedId("system-reminder")).toBe(`${brand.idPrefix}:system-reminder`);
		expect(envName("STATE_DIR")).toBe(`${brand.envPrefix}_STATE_DIR`);
		expect(productStateDir({}, "/home/u")).toBe(join("/home/u", brand.stateDir));
		expect(productStateDir({ [envName("STATE_DIR")]: "/elsewhere" }, "/home/u")).toBe("/elsewhere");
	});

	it("rejects a brand that misses a name or spells a prefix wrongly", () => {
		expect(() => checkBrand({ ...data, name: "" })).toThrow(/"name" must be a non-empty string/);
		expect(() => checkBrand({ ...data, envPrefix: "one-code" })).toThrow(/"envPrefix" must be upper-case/);
		expect(() => checkBrand({ ...data, idPrefix: "One Code" })).toThrow(/"idPrefix" must be lower-case/);
		expect(() => checkBrand({ ...data, packages: { app: "a" } })).toThrow(/"packages.extension"/);
		expect(checkBrand(data)).toEqual(data);
	});

	it("freezes a copy, leaving the JSON module's object for loaders that extend it (jiti adds `default`)", () => {
		expect(Object.isFrozen(brand)).toBe(true);
		expect(Object.isFrozen(data)).toBe(false);
		expect(brand).toEqual(data);
	});
});
