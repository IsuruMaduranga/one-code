/**
 * A profile imports the base only through `extensions/sdk/` (`profile.ts` for
 * its text, `source-provider.ts` for its source provider), so the base can
 * reorganize its folders without touching a product's profile
 * (working-docs/decisions/bi-fork.md). Type imports count: a moved type file
 * breaks a profile's typecheck as surely as a moved value. The profile's own
 * tests (`profile/test/`) are One Code's tests and may import anything.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SDK = ["extensions/sdk/profile.ts", "extensions/sdk/source-provider.ts"];

/** Every module specifier in `source`, type-only imports and re-exports included. */
function specifiers(source: string): string[] {
	return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
}

function profileSources(): string[] {
	return readdirSync(join(ROOT, "profile"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name))
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
		.filter((file) => !file.startsWith("profile/test/"));
}

describe("the profile's imports from the base", () => {
	it("all go through the SDK modules", () => {
		const outside: string[] = [];
		for (const file of profileSources()) {
			for (const spec of specifiers(readFileSync(join(ROOT, file), "utf8"))) {
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
