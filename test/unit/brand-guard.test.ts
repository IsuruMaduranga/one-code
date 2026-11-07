/**
 * Phase 4c's exit check (working-docs/features/profiles/plan.md): the base
 * names the product only through the profile's brand (extensions/lib/brand.mjs,
 * decisions/bi-fork.md "The brand is one static data file"). A new literal
 * fails here until it goes through `brandedId`, `envName`, `brand` or a
 * knob (lib/knobs.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");

/** Source without block and line comments (`//` after `:` is a URL). */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return name.endsWith(".ts") || name.endsWith(".mjs") ? [path] : [];
	});
}

function offenders(pattern: RegExp): string[] {
	return walk(ROOT)
		.filter((path) => pattern.test(withoutComments(readFileSync(path, "utf8"))))
		.map((path) => relative(ROOT, path).split("\\").join("/"));
}

describe("the base names the product only through its brand", () => {
	it("builds every internal id with brandedId", () => {
		expect(offenders(/["'`]one-code:/)).toEqual([]);
	});

	it("reads an environment knob by its suffix, never by Claude Code's spelling (the provider's alias)", () => {
		expect(offenders(/\bCLAUDE_CODE_[A-Z]/)).toEqual([]);
	});
});
