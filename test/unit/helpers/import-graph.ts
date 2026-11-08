/**
 * A module's value imports, read the way the compiler reads them (type-only
 * imports and re-exports are erased). Used by the import-graph tests.
 */
import ts from "typescript";

export interface ValueImport {
	specifier: string;
	/** `import()` or `require()`, which load on call rather than with the module. */
	dynamic: boolean;
}

/** The modules `source` loads as values: imports and re-exports that are not type-only, `import()` and `require()` of a literal. */
export function valueImports(source: string, path: string): ValueImport[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const found: ValueImport[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			const typeOnly =
				clause !== undefined &&
				(clause.isTypeOnly || (!clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)));
			if (!typeOnly) found.push({ specifier: node.moduleSpecifier.text, dynamic: false });
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.exportClause;
			const typeOnly = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
			if (!typeOnly) found.push({ specifier: node.moduleSpecifier.text, dynamic: false });
		} else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) found.push({ specifier: node.arguments[0].text, dynamic: true });
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}
