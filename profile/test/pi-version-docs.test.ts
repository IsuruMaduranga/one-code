/**
 * One Code's README, installation guide and CI workflow state the tested pi
 * range of extensions/lib/app/pi-version.ts. These files are the product's,
 * so the check is the product's too: another product has its own README and
 * workflow.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TESTED_PI_MAX_EXCLUSIVE, TESTED_PI_MIN } from "../../extensions/lib/app/pi-version.ts";

describe("One Code's docs and CI state the tested pi range", () => {
	const repoRoot = resolve(import.meta.dirname, "..", "..");
	const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
	const [maxMajor, maxMinor] = TESTED_PI_MAX_EXCLUSIVE.split(".").map(Number);
	const lastTested = `${maxMajor}.${(maxMinor ?? 0) - 1}`;

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
