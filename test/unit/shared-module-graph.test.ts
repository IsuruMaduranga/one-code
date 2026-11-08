/**
 * The profile and its source provider load through `sharedModule`
 * (lib/shared-module.ts), which under pi is the calling extension's jiti
 * `require`. In the bundled app pi resolves its own packages by alias, and a
 * synchronous `require` of pi's `dist/` then transpiles it under those aliases:
 * pi's deep `@earendil-works/pi-ai/utils/retry` import is rewritten to a dead
 * path and every extension that loads the provider fails (findings §10, the
 * app smoke test). So neither module graph may import a pi package as a value;
 * type imports are erased and fine.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { profile } from "../../profile/index.ts";
import { valueImports } from "./helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const valueSpecifiers = (source: string, path: string): string[] => valueImports(source, path).map((found) => found.specifier);

/** Every value import of a pi package in the graph under `entry`, with the importing file. */
function piValueImports(entry: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	const walk = (file: string) => {
		const path = normalize(file);
		if (seen.has(path) || !existsSync(path)) return;
		seen.add(path);
		for (const spec of valueSpecifiers(readFileSync(path, "utf8"), path)) {
			if (spec.startsWith(".")) walk(join(dirname(path), spec));
			else if (spec.startsWith("@earendil-works/")) found.push(`${relative(ROOT, path)} imports ${spec}`);
		}
	};
	walk(entry);
	return found;
}

describe("modules loaded through sharedModule", () => {
	it("sees value imports the way the compiler does", () => {
		const specs = valueSpecifiers(
			'export { type Foo };\nimport { main } from "@earendil-works/a";\nimport { type B } from "@earendil-works/b";\nimport type C from "@earendil-works/c";\nexport { type D } from "@earendil-works/d";\nexport * from \'@earendil-works/e\';\nawait import("@earendil-works/f");\nrequire("@earendil-works/g");',
			"x.ts",
		);
		expect(specs).toEqual(["@earendil-works/a", "@earendil-works/e", "@earendil-works/f", "@earendil-works/g"]);
	});

	it("import no pi package as a value: the profile", () => {
		expect(piValueImports(join(ROOT, "profile", "index.ts"))).toEqual([]);
	});

	it("import no pi package as a value: the profile's source provider, when it has one", () => {
		// A source provider is optional (lib/sources.ts); a profile without one has no graph here.
		expect(profile.sources === undefined ? [] : piValueImports(join(ROOT, "profile", profile.sources))).toEqual([]);
	});
});
