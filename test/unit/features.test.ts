/**
 * The feature registry (lib/profile/features.ts) agrees with what pi loads: every
 * entry in package.json `pi.extensions` and in the child list belongs to
 * exactly one feature, every registered entry exists and wraps its factory in
 * `feature(<its id>, …)`, and the switch rules hold.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS } from "../../extensions/lib/agents/child-extensions.ts";
import { enabledFeatures, FEATURE_IDS, FEATURES, featureOfEntry, featureProblems, PRODUCT_EXTENSIONS_ENTRY, TOOL_FEATURES } from "../../extensions/lib/profile/features.ts";

const repo = join(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { pi: { extensions: string[] } };
// The product's entry (a glob over `profile/extensions/`) belongs to no feature.
const manifestEntries = manifest.pi.extensions.filter((path) => path !== PRODUCT_EXTENSIONS_ENTRY).map((path) => path.replace(/^extensions\//, ""));
const registered = FEATURE_IDS.flatMap((id) => FEATURES[id].entries.map((entry) => ({ id, entry })));

describe("feature registry", () => {
	it("covers every entry pi loads, in the main session and in children", () => {
		for (const entry of [...manifestEntries, ...CHILD_EXTENSIONS]) expect(featureOfEntry(entry), entry).toBeDefined();
	});

	it("loads a product's own extensions last, after system-prompt", () => {
		// After every base listener (the bus does not replay) and after the
		// request pipeline, and the only entry outside `extensions/`.
		expect(manifest.pi.extensions.at(-1)).toBe(PRODUCT_EXTENSIONS_ENTRY);
		expect(manifest.pi.extensions.at(-2)).toBe("extensions/request/system-prompt/index.ts");
		expect(manifest.pi.extensions.filter((path) => !path.startsWith("extensions/"))).toEqual([PRODUCT_EXTENSIONS_ENTRY]);
	});

	it("names each entry once, and only entries that are loaded", () => {
		const entries = registered.map((r) => r.entry);
		expect(new Set(entries).size).toBe(entries.length);
		const loaded = new Set([...manifestEntries, ...CHILD_EXTENSIONS]);
		for (const entry of entries) expect(loaded.has(entry), entry).toBe(true);
	});

	it("every entry exports its factory through feature() with its own id", () => {
		for (const { id, entry } of registered) {
			const file = join(repo, "extensions", entry);
			expect(existsSync(file), file).toBe(true);
			const source = readFileSync(file, "utf8");
			expect(source, entry).toMatch(new RegExp(`^export default feature\\("${id}", \\w+\\);$`, "m"));
			expect(source, entry).not.toMatch(/^export default function/m);
		}
	});

	it("maps every tool an optional feature's entry registers by name to that feature", () => {
		for (const { id, entry } of registered) {
			if ("required" in FEATURES[id]) continue;
			const source = readFileSync(join(repo, "extensions", entry), "utf8");
			for (const [, tool] of source.matchAll(/registerTool\(\{\s*name: "(\w+)"/g)) expect(TOOL_FEATURES[tool], `${entry}: ${tool}`).toBe(id);
		}
	});
});

describe("feature maps", () => {
	it("turns everything on by default and off what the map says", () => {
		expect(enabledFeatures({}).size).toBe(FEATURE_IDS.length);
		const on = enabledFeatures({ plugins: false, notebook: true });
		expect(on.has("plugins")).toBe(false);
		expect(on.has("notebook")).toBe(true);
	});

	it("reports a required feature turned off and an unknown name", () => {
		expect(featureProblems({ permissions: false, plugin: false })).toEqual([
			'unknown feature "plugin"',
			'"permissions" is part of the safety core or the request pipeline and cannot be turned off',
		]);
		expect(featureProblems({ plugins: false })).toEqual([]);
	});

	it("keeps the agreed core required", () => {
		const required = FEATURE_IDS.filter((id) => "required" in FEATURES[id]).sort();
		expect(required).toEqual(["cache-marks", "kept-thinking", "ledger", "permissions", "secret-values", "system-prompt", "system-reminder", "tool-search"]);
	});
});
