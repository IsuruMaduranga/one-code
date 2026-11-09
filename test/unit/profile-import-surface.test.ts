/**
 * A profile imports the base only through `extensions/sdk/` (`profile.ts` for
 * its text, `source-provider.ts` for its source provider), so the base can
 * reorganize its folders without touching a product's profile
 * (working-docs/decisions/bi-fork.md). Type imports count: a moved type file
 * breaks a profile's typecheck as surely as a moved value. The profile's own
 * tests (`profile/test/`) are One Code's tests and may import anything.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { imports, sourceFiles } from "./helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SDK = ["extensions/sdk/profile.ts", "extensions/sdk/source-provider.ts"];

/** Every module specifier in `source`, type-only imports and re-exports included. */
const specifiers = (source: string, path = "x.ts") => imports(source, path).map((found) => found.specifier);

describe("the profile's imports from the base", () => {
	it("all go through the SDK modules", () => {
		const outside: string[] = [];
		for (const file of sourceFiles(join(ROOT, "profile"), ROOT).filter((f) => !f.startsWith("profile/test/"))) {
			for (const spec of specifiers(readFileSync(join(ROOT, file), "utf8"), file)) {
				if (!spec.startsWith(".")) continue;
				const target = relative(ROOT, resolve(ROOT, dirname(file), spec)).replaceAll("\\", "/");
				if (!target.startsWith("profile/") && !SDK.includes(target)) outside.push(`${file} imports ${target}`);
			}
		}
		expect(outside).toEqual([]);
	});

	it("sees type-only imports and re-exports", () => {
		const source = 'import type { A } from "./a.ts";\nexport type { B } from "./b.ts";\nimport { type C } from "./c.ts";\nexport * from "./d.ts";';
		expect(specifiers(source)).toEqual(["./a.ts", "./b.ts", "./c.ts", "./d.ts"]);
	});
});
