/**
 * The package root every module that reads a shipped file starts from
 * (lib/core/package-root.ts): the extension package's own directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_DIR } from "../../extensions/lib/agents/guide-docs.ts";
import { brand } from "../../extensions/lib/profile/brand.mjs";
import { EXTENSIONS_DIR, PACKAGE_ROOT } from "../../extensions/lib/core/package-root.ts";

describe("the package root", () => {
	it("is the extension package's directory", () => {
		// Brand-independent (the base suite runs under the fixture's brand): the
		// root's manifest lists the extension entries that sit under EXTENSIONS_DIR.
		const entries: string[] = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).pi.extensions;
		expect(entries.length).toBeGreaterThan(0);
		// The one glob entry (a product's own extensions) may match nothing.
		for (const entry of entries.filter((entry) => !entry.includes("*"))) expect(existsSync(join(PACKAGE_ROOT, entry)), entry).toBe(true);
		expect(existsSync(join(EXTENSIONS_DIR, "lib", "core", "package-root.ts"))).toBe(true);
	});

	it("is what the app's launcher hands createApp, however deep the launcher module sits", () => {
		// The launcher once counted folders up from create-app.mjs; a folder move
		// then pointed the app at `extensions/` and no unit test noticed.
		const launcher = readFileSync(join(PACKAGE_ROOT, "app", "bin.mjs"), "utf8");
		const segments = launcher.match(/createAppPath = join\(corePath, ([^)]+)\)/)?.[1].split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
		expect(segments, "bin.mjs builds createAppPath from corePath").toBeDefined();
		expect(existsSync(join(PACKAGE_ROOT, ...segments!))).toBe(true);
		expect(launcher).toMatch(/corePath = dirname\(require\.resolve\(`\$\{app\.productExtension\}\/package\.json`\)\)/);
		expect(launcher).not.toMatch(/dirname\(dirname\(/);
	});

	it("holds the user guide the brand names, when the product ships one", () => {
		// A brand that sets `guideDir` promises the folder; the default `profile/guide` may be absent.
		if (brand.guideDir !== undefined) expect(existsSync(join(GUIDE_DIR, "README.md"))).toBe(true);
		expect(GUIDE_DIR).toBe(join(PACKAGE_ROOT, ...(brand.guideDir ?? "profile/guide").split("/")));
	});
});
