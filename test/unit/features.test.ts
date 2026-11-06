/**
 * The feature registry (lib/features.ts) agrees with what pi loads: every
 * entry in package.json `pi.extensions` and in the child list belongs to
 * exactly one feature, every registered entry exists and wraps its factory in
 * `feature(<its id>, …)`, and the switch rules hold.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS, childEntry } from "../../extensions/lib/child-extensions.ts";
import { enabledFeatures, FEATURE_IDS, FEATURES, featureOfEntry, featureProblems, TOOL_FEATURES } from "../../extensions/lib/features.ts";

const repo = join(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { pi: { extensions: string[] } };
const manifestEntries = manifest.pi.extensions.map((path) => path.replace(/^extensions\//, ""));
const childEntries = CHILD_EXTENSIONS.map(childEntry);
const registered = FEATURE_IDS.flatMap((id) => FEATURES[id].entries.map((entry) => ({ id, entry })));

describe("feature registry", () => {
	it("covers every entry pi loads, in the main session and in children", () => {
		for (const entry of [...manifestEntries, ...childEntries]) expect(featureOfEntry(entry), entry).toBeDefined();
	});

	it("names each entry once, and only entries that are loaded", () => {
		const entries = registered.map((r) => r.entry);
		expect(new Set(entries).size).toBe(entries.length);
		const loaded = new Set([...manifestEntries, ...childEntries]);
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
		expect(required).toEqual(["cache-marks", "kept-thinking", "ledger", "permissions", "system-prompt", "system-reminder", "tool-search"]);
	});
});
