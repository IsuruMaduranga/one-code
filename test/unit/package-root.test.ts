/**
 * The package root every module that reads a shipped file starts from
 * (lib/core/package-root.ts): the extension package's own directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_CODE_GUIDE_DIR } from "../../extensions/lib/agents/guide-docs.ts";
import { EXTENSIONS_DIR, PACKAGE_ROOT } from "../../extensions/lib/core/package-root.ts";

describe("the package root", () => {
	it("is the extension package's directory", () => {
		// Brand-independent (the base suite runs under the fixture's brand): the
		// root's manifest lists the extension entries that sit under EXTENSIONS_DIR.
		const entries: string[] = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).pi.extensions;
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) expect(existsSync(join(PACKAGE_ROOT, entry)), entry).toBe(true);
		expect(existsSync(join(EXTENSIONS_DIR, "lib", "core", "package-root.ts"))).toBe(true);
	});

	it("holds the user guide the guide agent reads", () => {
		expect(existsSync(join(ONE_CODE_GUIDE_DIR, "README.md"))).toBe(true);
	});
});
