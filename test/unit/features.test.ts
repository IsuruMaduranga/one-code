/**
 * The feature registry (lib/features.ts) agrees with what pi loads: every
 * entry in package.json `pi.extensions` and in the child list belongs to
 * exactly one feature, every registered entry exists and wraps its factory in
 * `feature(<its id>, …)`, and the switch rules hold.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS } from "../../extensions/lib/child-extensions.ts";
import { FEATURE_IDS, FEATURES, featureOfEntry, resolveFeatures } from "../../extensions/lib/features.ts";

const repo = join(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { pi: { extensions: string[] } };
const manifestEntries = manifest.pi.extensions.map((path) => path.replace(/^extensions\//, ""));
const childEntries = CHILD_EXTENSIONS.map((name) => (name.includes("/") ? `${name}.ts` : `${name}/index.ts`));
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
});

describe("resolveFeatures", () => {
	it("turns everything on by default", () => {
		expect(resolveFeatures({}).size).toBe(FEATURE_IDS.length);
	});

	it("turns off what the profile or the environment names", () => {
		const on = resolveFeatures({ plugins: false, notebook: true }, ["mcp"]);
		expect(on.has("plugins")).toBe(false);
		expect(on.has("mcp")).toBe(false);
		expect(on.has("notebook")).toBe(true);
	});

	it("refuses a required feature turned off, by either route", () => {
		expect(() => resolveFeatures({ permissions: false })).toThrow(/"permissions" is part of the safety core/);
		expect(() => resolveFeatures({}, ["ledger"])).toThrow(/"ledger" is part of the safety core/);
	});

	it("refuses unknown feature names", () => {
		expect(() => resolveFeatures({ plugin: false } as never)).toThrow(/unknown feature "plugin"/);
		expect(() => resolveFeatures({}, ["nope"])).toThrow(/ONECODE_FEATURES_OFF names an unknown feature "nope"/);
	});

	it("keeps the agreed core required", () => {
		const required = FEATURE_IDS.filter((id) => "required" in FEATURES[id]).sort();
		expect(required).toEqual(["cache-marks", "kept-thinking", "ledger", "permissions", "system-prompt", "system-reminder", "tool-search"]);
	});
});
