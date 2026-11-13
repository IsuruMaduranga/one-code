/**
 * Phase 4c's exit check (working-docs/features/profiles/plan.md): the base
 * names the product only through the profile's brand (extensions/lib/profile/brand.mjs,
 * decisions/bi-fork.md "The brand is one static data file"). A new literal
 * fails here until it goes through `brandedId`, `envName`, `brand` or a
 * knob (lib/profile/knobs.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");

const printer = ts.createPrinter({ removeComments: true });

/** Source without comments, by the compiler's own parse: a `//` or `/*` inside a string, template or regex stays. */
function withoutComments(source: string, path: string): string {
	return printer.printFile(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return name.endsWith(".ts") || name.endsWith(".mjs") ? [path] : [];
	});
}

/** The base's own scripts name the product through the brand too. */
const SCRIPTS = join(ROOT, "..", "scripts");

function offenders(pattern: RegExp): string[] {
	return [...walk(ROOT), ...walk(SCRIPTS)]
		.filter((path) => pattern.test(withoutComments(readFileSync(path, "utf8"), path)))
		.map((path) => relative(join(ROOT, ".."), path).split("\\").join("/").replace(/^extensions\//, ""));
}

describe("the base names the product only through its brand", () => {
	it("strips comments but keeps every literal that looks like one", () => {
		const kept = withoutComments('const g = "**/*.ts"; /* gone */ const u = `a//b`; // gone\nconst n = "One Code";', "x.ts");
		expect(kept).not.toContain("gone");
		expect(kept).toContain('"**/*.ts"');
		expect(kept).toContain("`a//b`");
		expect(kept).toContain('"One Code"');
	});

	it("builds every internal id with brandedId", () => {
		expect(offenders(/["'`]one-code:/)).toEqual([]);
	});

	it("names the product, its paths, packages and variables only through the brand", () => {
		expect(offenders(/One Code|one-code(?!:)/)).toEqual([]);
		// In any case and inside an identifier too (`homeOneCodeDir`): a name in the base says "product".
		expect(offenders(/onecode/i)).toEqual([]);
	});

	it("reads an environment knob by its suffix, never by Claude Code's spelling (the provider's alias)", () => {
		expect(offenders(/\bCLAUDE_CODE_[A-Z]/)).toEqual([]);
	});
});
