import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brand } from "../../extensions/lib/brand.mjs";
import { stampApp, stampExtension } from "../../scripts/apply-brand.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

describe("apply-brand", () => {
	it("leaves the committed package.json files as they are: they match the brand", () => {
		const run = spawnSync(process.execPath, [join(ROOT, "scripts", "apply-brand.mjs"), "--check"], { encoding: "utf8" });
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
	});

	it("renames another product's packages, command and extension dependency in place", () => {
		const app = stampApp({
			name: "@other/app",
			version: "1.0.0",
			bin: { other: "bin.mjs" },
			productExtension: "other-extension",
			files: ["bin.mjs"],
			dependencies: { "@earendil-works/pi-coding-agent": "1.5.0", "other-extension": "1.0.0" },
		});
		expect(app).toMatchObject({
			name: brand.packages.app,
			version: "1.0.0",
			bin: { [brand.bin]: "bin.mjs" },
			productExtension: brand.packages.extension,
			files: ["bin.mjs"],
			dependencies: { "@earendil-works/pi-coding-agent": "1.5.0", [brand.packages.extension]: "1.0.0" },
		});
		expect(Object.keys(app)).toEqual(["name", "version", "bin", "productExtension", "files", "dependencies", "description", "keywords", "repository", "homepage", "bugs"]);
		expect(stampExtension({ name: "other-extension", version: "1.0.0" })).toMatchObject({ name: brand.packages.extension, version: "1.0.0" });
	});

	it("stamps each package's listing from the brand, keeping field order and a repository directory", () => {
		const app = stampApp({
			name: "@other/app",
			description: "Other",
			bin: { other: "bin.mjs" },
			productExtension: "other-extension",
			repository: { type: "git", url: "git+https://example.com/other.git", directory: "app" },
			homepage: "https://example.com/other",
			dependencies: { "other-extension": "1.0.0" },
		});
		expect(app.description).toBe(brand.packageInfo.app.description);
		expect(app.keywords).toEqual(brand.packageInfo.app.keywords);
		expect(app.repository).toEqual({ type: "git", url: `git+${brand.homepage}.git`, directory: "app" });
		expect(app.homepage).toBe(`${brand.homepage}#readme`);
		expect(app.bugs).toEqual({ url: `${brand.homepage}/issues` });
		expect(Object.keys(app)).toEqual(["name", "description", "bin", "productExtension", "repository", "homepage", "dependencies", "keywords", "bugs"]);
		const extension = stampExtension({ name: "other-extension", description: "Other", version: "1.0.0" });
		expect(extension.description).toBe(brand.packageInfo.extension.description);
		expect(extension.repository).toEqual({ type: "git", url: `git+${brand.homepage}.git` });
		expect(Object.keys(extension).slice(0, 3)).toEqual(["name", "description", "version"]);
	});

	it("fails loud when the app names no extension dependency", () => {
		expect(() => stampApp({ name: "a", bin: {}, productExtension: "missing", dependencies: {} })).toThrow(/no dependency named by productExtension/);
	});
});
