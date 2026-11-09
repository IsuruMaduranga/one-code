/**
 * The layers of `extensions/` (working-docs/reviews/DESIGN-REVIEW-2026-11-09.md
 * L2). A folder under `extensions/` is `lib/` (shared code), `sdk/` (the
 * surfaces a product imports) or a feature's folder (`lib/features.ts`), and:
 *
 * - `lib/` never loads a feature's module: a value import of a feature file
 *   makes every feature that uses the lib module depend on that feature.
 *   Type imports are erased and allowed (`lib/profile-contract.ts` names
 *   each feature's text types).
 * - A feature never imports another feature's files, except the type of
 *   another feature's words (`text.ts`). Cross-feature data goes over
 *   `pi.events`; shared code goes to `lib/`.
 * - Nothing imports another feature's entry file: under jiti each importer
 *   would load its own copy of that extension (findings §3).
 *
 * `doctor` reports on every feature and may read their modules. Today's other
 * violations are frozen in `import-layers-allowlist.ts`; the list only shrinks.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FEATURES } from "../../extensions/lib/features.ts";
import { valueImports } from "./helpers/import-graph.ts";
import { IMPORT_LAYER_VIOLATIONS } from "./import-layers-allowlist.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const AGGREGATORS = new Set(["doctor"]);

const entries = new Set(Object.values(FEATURES).flatMap((spec) => spec.entries.map((entry) => `extensions/${entry}`)));
const featureDirs = new Map<string, string>(); // dir -> feature id
for (const [id, spec] of Object.entries(FEATURES)) for (const entry of spec.entries) featureDirs.set(posix.dirname(`extensions/${entry}`), id);

/** `lib`, `sdk`, or the id of the feature whose folder holds `file`; undefined outside `extensions/`. */
function unitOf(file: string): string | undefined {
	if (!file.startsWith("extensions/")) return undefined;
	if (file.startsWith("extensions/lib/")) return "lib";
	if (file.startsWith("extensions/sdk/")) return "sdk";
	let best: [string, string] | undefined;
	for (const [dir, id] of featureDirs) if (file.startsWith(`${dir}/`) && (!best || dir.length > best[0].length)) best = [dir, id];
	return best ? best[1] : `unknown:${file.split("/")[1]}`;
}

function sources(): string[] {
	return readdirSync(join(ROOT, "extensions"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(ts|mts|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".test.ts"))
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

const resolveFrom = (file: string, spec: string) => posix.normalize(posix.join(posix.dirname(file), spec));

function violations(): string[] {
	const found = new Set<string>();
	for (const file of sources()) {
		const from = unitOf(file);
		if (from?.startsWith("unknown:")) {
			found.add(`${file}: a folder under extensions/ that is not lib/, sdk/ or a feature`);
			continue;
		}
		const source = readFileSync(join(ROOT, file), "utf8");
		const values = new Set(valueImports(source, file).filter((i) => i.specifier.startsWith(".")).map((i) => resolveFrom(file, i.specifier)));
		const all = new Set(ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName).filter((s) => s.startsWith(".")).map((s) => resolveFrom(file, s)));
		for (const target of all) {
			const to = unitOf(target);
			if (!to || to === "lib" || to === "sdk" || to === from) continue;
			const isValue = values.has(target);
			if (entries.has(target) && isValue) found.add(`${file} -> ${target}`);
			else if (from === "lib" && isValue) found.add(`${file} -> ${target}`);
			else if (from !== "lib" && from !== "sdk" && !AGGREGATORS.has(from ?? "") && !(target.endsWith("/text.ts") && !isValue)) found.add(`${file} -> ${target}`);
		}
	}
	return [...found].sort();
}

describe("the layers of extensions/", () => {
	const found = violations();
	it("has no violation beyond the frozen list", () => {
		expect(found.filter((v) => !IMPORT_LAYER_VIOLATIONS.includes(v))).toEqual([]);
	});
	it("keeps no fixed violation on the frozen list", () => {
		expect(IMPORT_LAYER_VIOLATIONS.filter((v) => !found.includes(v))).toEqual([]);
	});
	it("names every feature folder in the registry", () => {
		expect([...featureDirs.keys()].every((dir) => dirname(dir).startsWith("extensions"))).toBe(true);
	});
});
