/**
 * A module's imports, read the way the compiler reads them, and the source
 * files the import-graph tests walk (import-cycles, import-layers,
 * profile-import-surface, shared-module-graph).
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export interface FoundImport {
	specifier: string;
	/** Erased by the compiler: `import type`, `export type`, or every named binding marked `type`. */
	typeOnly: boolean;
	/** `import()` or `require()`, which load on call rather than with the module. */
	dynamic: boolean;
}

/** Every module `source` names: imports and re-exports (type-only ones flagged), `import()` and `require()` of a literal. */
export function imports(source: string, path: string): FoundImport[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const found: FoundImport[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			const typeOnly =
				clause !== undefined &&
				(clause.isTypeOnly || (!clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)));
			found.push({ specifier: node.moduleSpecifier.text, typeOnly, dynamic: false });
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.exportClause;
			const typeOnly = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
			found.push({ specifier: node.moduleSpecifier.text, typeOnly, dynamic: false });
		} else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
				found.push({ specifier: node.arguments[0].text, typeOnly: false, dynamic: true });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** The modules `source` loads as values: its imports minus the type-only ones the compiler erases. */
export function valueImports(source: string, path: string): FoundImport[] {
	return imports(source, path).filter((found) => !found.typeOnly);
}

/** Source modules under `dir` (tests and declaration files left out), as forward-slashed paths relative to `root`. */
export function sourceFiles(dir: string, root: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(ts|mts|mjs|js)$/.test(entry.name) && !/\.(d|test)\.ts$/.test(entry.name))
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
		.sort();
}
