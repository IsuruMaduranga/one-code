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

const ROOT = join(import.meta.dirname, "..", "..");
const IMPORT = /^(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)"|^import\s+"([^"]+)"/gm;

/** Every value import of a pi package in the graph under `entry`, with the importing file. */
function piValueImports(entry: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	const walk = (file: string) => {
		const path = normalize(file);
		if (seen.has(path) || !existsSync(path)) return;
		seen.add(path);
		for (const match of readFileSync(path, "utf8").matchAll(IMPORT)) {
			const spec = match[3] ?? match[4];
			if (match[1]) continue;
			const names = (match[2] ?? "").trim();
			const inner = names.replace(/^\{|\}$/g, "").trim();
			if (names.startsWith("{") && inner && inner.split(",").every((name) => !name.trim() || name.trim().startsWith("type "))) continue;
			if (spec.startsWith(".")) walk(join(dirname(path), spec));
			else if (spec.startsWith("@earendil-works/")) found.push(`${relative(ROOT, path)} imports ${spec}`);
		}
	};
	walk(entry);
	return found;
}

describe("modules loaded through sharedModule", () => {
	it("import no pi package as a value: the profile", () => {
		expect(piValueImports(join(ROOT, "profile", "index.ts"))).toEqual([]);
	});

	it("import no pi package as a value: the profile's source provider", () => {
		expect(profile.sources).toBeDefined();
		expect(piValueImports(join(ROOT, "profile", profile.sources!))).toEqual([]);
	});
});
