/**
 * The layers of `extensions/` (working-docs/reviews/DESIGN-REVIEW-2026-11-09.md
 * L2). A folder under `extensions/` is `lib/` (shared code), `sdk/` (the
 * surfaces a product imports) or a feature's folder (`lib/profile/features.ts`), and:
 *
 * - `lib/` never loads a feature's module: a value import of a feature file
 *   makes every feature that uses the lib module depend on that feature.
 *   Type imports are erased and allowed (`lib/profile/profile-contract.ts` names
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
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURES } from "../../extensions/lib/profile/features.ts";
import { imports, sourceFiles } from "./helpers/import-graph.ts";
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

const resolveFrom = (file: string, spec: string) => posix.normalize(posix.join(posix.dirname(file), spec));

function violations(): string[] {
	const found = new Set<string>();
	for (const file of sourceFiles(join(ROOT, "extensions"), ROOT)) {
		const from = unitOf(file);
		if (!from) continue; // every walked file is under extensions/
		if (from.startsWith("unknown:")) {
			found.add(`${file}: a folder under extensions/ that is not lib/, sdk/ or a feature`);
			continue;
		}
		const targets = new Map<string, boolean>(); // target -> loaded as a value
		for (const found of imports(readFileSync(join(ROOT, file), "utf8"), file)) {
			if (!found.specifier.startsWith(".")) continue;
			const target = resolveFrom(file, found.specifier);
			targets.set(target, targets.get(target) === true || !found.typeOnly);
		}
		const isFeature = from !== "lib" && from !== "sdk";
		for (const [target, isValue] of targets) {
			const to = unitOf(target);
			if (!to || to === "lib" || to === "sdk" || to === from) continue;
			const bad =
				(isValue && (entries.has(target) || from === "lib")) ||
				(isFeature && !AGGREGATORS.has(from) && !(target.endsWith("/text.ts") && !isValue));
			if (bad) found.add(`${file} -> ${target}`);
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
});
