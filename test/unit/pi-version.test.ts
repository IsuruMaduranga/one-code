import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
		expect(piVersionWarning("0.85.1")).toBeUndefined();
	});

	it("warns below and at/above the range", () => {
		expect(piVersionWarning("0.82.9")).toContain("tested against");
		// 0.83.0 through 0.84.2 lack createPowerShellToolDefinition: the extension set does not load there.
		expect(piVersionWarning("0.84.2")).toContain("tested against");
		expect(piVersionWarning(TESTED_PI_MAX_EXCLUSIVE)).toContain(`tested against pi ${TESTED_PI_MIN}`);
		expect(piVersionWarning(TESTED_PI_MAX_EXCLUSIVE)).toContain(`running pi ${TESTED_PI_MAX_EXCLUSIVE}`);
	});

	it("fails silent on missing or unparseable versions", () => {
		expect(piVersionWarning(undefined)).toBeUndefined();
		expect(piVersionWarning("0.84.1-nightly")).toBeUndefined();
	});
});

describe("the tested range is the one the package, the guide and CI state", () => {
	const repoRoot = resolve(import.meta.dirname, "..", "..");
	const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
	const [maxMajor, maxMinor] = TESTED_PI_MAX_EXCLUSIVE.split(".").map(Number);
	const lastTested = `${maxMajor}.${(maxMinor ?? 0) - 1}`;

	it("the peer range starts at the tested minimum", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(`>=${TESTED_PI_MIN}`);
	});

	it("the pi the repo develops against is inside the range", () => {
		const pi = JSON.parse(read("node_modules/@earendil-works/pi-coding-agent/package.json")).version;
		expect(piVersionWarning(pi)).toBeUndefined();
	});

	it("the README and the installation guide name the same range", () => {
		for (const path of ["README.md", "docs/guide/installation.md"]) {
			expect(read(path).replace(/\s+/g, " "), path).toContain(`${TESTED_PI_MIN} through ${lastTested}`);
		}
	});

	it("CI runs the floor smoke against the tested minimum", () => {
		const ci = read(".github/workflows/ci.yml");
		expect(ci).toContain("test/e2e/pi-floor-smoke.mjs");
		expect(ci).toContain("TESTED_PI_MIN");
	});
});
