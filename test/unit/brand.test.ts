import { join } from "node:path";
import { describe, expect, it } from "vitest";
import data from "../../profile/brand.json" with { type: "json" };
import { type Brand, brand, brandedId, checkBrand, envName, productStateDir } from "../../extensions/lib/profile/brand.mjs";

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
		expect(() => checkBrand({ ...data, stateDir: ".BICopilot" })).toThrow(/"stateDir" must be one lower-case folder name/);
		expect(() => checkBrand({ ...data, stateDir: "a/b" })).toThrow(/"stateDir"/);
		// A plain word would be a protected path segment in every project.
		expect(() => checkBrand({ ...data, stateDir: "agent" })).toThrow(/starting with "\."/);
		expect(() => checkBrand({ ...data, packages: { app: "a" } })).toThrow(/"packages.extension"/);
		expect(() => checkBrand({ ...data, packageInfo: { app: data.packageInfo.app } })).toThrow(/"packageInfo.extension.description"/);
		expect(() => checkBrand({ ...data, packageInfo: { ...data.packageInfo, app: { description: "a", keywords: [1] } } })).toThrow(/"packageInfo.app.keywords"/);
		expect(checkBrand(data)).toEqual(data);
	});

	it("freezes a copy, leaving the JSON module's object for loaders that extend it (jiti adds `default`)", () => {
		expect(Object.isFrozen(brand)).toBe(true);
		expect(Object.isFrozen(brand.packageInfo.app.keywords)).toBe(true);
		expect(Object.isFrozen(data)).toBe(false);
		expect(brand).toEqual(data);
	});
});
