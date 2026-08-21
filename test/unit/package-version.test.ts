import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { extensionVersion } from "../../extensions/lib/package-version.ts";

const rootPkg = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
		"utf8",
	),
) as { version: string };

describe("extensionVersion", () => {
	it("returns the extension's own package.json version", () => {
		expect(extensionVersion()).toBe(rootPkg.version);
	});

	it("is never the sentinel fallback for a real release", () => {
		expect(extensionVersion()).not.toBe("0.0.0");
	});
});
