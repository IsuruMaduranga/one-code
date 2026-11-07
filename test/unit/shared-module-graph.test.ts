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
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { profile } from "../../profile/index.ts";

const ROOT = join(import.meta.dirname, "..", "..");
/** The specifiers `source` loads as values: imports and re-exports that are not type-only, `import()` and `require()` of a literal. */
function valueSpecifiers(source: string, path: string): string[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const specs: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			const typeOnly =
				clause !== undefined &&
				(clause.isTypeOnly || (!clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)));
			if (!typeOnly) specs.push(node.moduleSpecifier.text);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.exportClause;
			const typeOnly = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
			if (!typeOnly) specs.push(node.moduleSpecifier.text);
		} else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) specs.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return specs;
}

/** Every value import of a pi package in the graph under `entry`, with the importing file. */
function piValueImports(entry: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	const walk = (file: string) => {
		const path = normalize(file);
		if (seen.has(path) || !existsSync(path)) return;
		seen.add(path);
		for (const spec of valueSpecifiers(readFileSync(path, "utf8"), path)) {
			if (spec.startsWith(".")) walk(join(dirname(path), spec));
			else if (spec.startsWith("@earendil-works/")) found.push(`${relative(ROOT, path)} imports ${spec}`);
		}
	};
	walk(entry);
	return found;
}

describe("modules loaded through sharedModule", () => {
	it("sees value imports the way the compiler does", () => {
		const specs = valueSpecifiers(
			'export { type Foo };\nimport { main } from "@earendil-works/a";\nimport { type B } from "@earendil-works/b";\nimport type C from "@earendil-works/c";\nexport { type D } from "@earendil-works/d";\nexport * from \'@earendil-works/e\';\nawait import("@earendil-works/f");\nrequire("@earendil-works/g");',
			"x.ts",
		);
		expect(specs).toEqual(["@earendil-works/a", "@earendil-works/e", "@earendil-works/f", "@earendil-works/g"]);
	});

	it("import no pi package as a value: the profile", () => {
		expect(piValueImports(join(ROOT, "profile", "index.ts"))).toEqual([]);
	});

	it("import no pi package as a value: the profile's source provider", () => {
		expect(profile.sources).toBeDefined();
		expect(piValueImports(join(ROOT, "profile", profile.sources!))).toEqual([]);
	});
});
