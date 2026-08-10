import { describe, expect, it } from "vitest";
import {
	compareVersions,
	parseVersion,
	piVersionWarning,
	TESTED_PI_MAX_EXCLUSIVE,
	TESTED_PI_MIN,
} from "../../extensions/lib/pi-version.ts";

describe("parseVersion", () => {
	it("parses plain dotted numerics", () => {
		expect(parseVersion("0.84.1")).toEqual([0, 84, 1]);
		expect(parseVersion("1.0")).toEqual([1, 0]);
	});

	it("rejects prerelease tags, ranges, and garbage", () => {
		expect(parseVersion("0.84.1-beta.2")).toBeUndefined();
		expect(parseVersion("^0.84.0")).toBeUndefined();
		expect(parseVersion("")).toBeUndefined();
		expect(parseVersion("a.b.c")).toBeUndefined();
	});
});

describe("compareVersions", () => {
	it("orders triples, padding missing segments with zero", () => {
		expect(compareVersions("0.84.1", "0.84.1")).toBe(0);
		expect(compareVersions("0.83.9", "0.84.0")).toBe(-1);
		expect(compareVersions("0.85.0", "0.84.99")).toBe(1);
		expect(compareVersions("0.84", "0.84.0")).toBe(0);
	});

	it("is undefined when either side is unparseable", () => {
		expect(compareVersions("0.84.x", "0.84.0")).toBeUndefined();
	});
});

describe("piVersionWarning", () => {
	it("is silent inside the tested range", () => {
		expect(piVersionWarning(TESTED_PI_MIN)).toBeUndefined();
		expect(piVersionWarning("0.84.1")).toBeUndefined();
	});

	it("warns below and at/above the range", () => {
		expect(piVersionWarning("0.82.9")).toContain("tested against");
		expect(piVersionWarning(TESTED_PI_MAX_EXCLUSIVE)).toContain("tested against");
		expect(piVersionWarning("1.0.0")).toContain("1.0.0");
	});

	it("fails silent on missing or unparseable versions", () => {
		expect(piVersionWarning(undefined)).toBeUndefined();
		expect(piVersionWarning("0.84.1-nightly")).toBeUndefined();
	});
});
