/**
 * The sentence-like string literals in a TypeScript file, outside comments:
 * plain strings and template text with at least four words. The text moves
 * between the profile and the base are checked with it: the sentences a
 * move removes from one side are the ones it adds to the other.
 */
import ts from "typescript";

/** Four or more words of letters, the first one capitalized or not: prose, not an identifier, a path or a format. */
const SENTENCE = /[A-Za-z][A-Za-z'’]*(?:,?\s+[A-Za-z][A-Za-z'’]*){3,}/;

export function sentenceLiterals(source: string, fileName = "file.ts"): string[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		// Module specifiers and type positions are code, not text.
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			if (SENTENCE.test(node.text)) found.push(node.text);
		} else if (ts.isTemplateExpression(node)) {
			const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
			const joined = parts.join("${…}");
			if (parts.some((part) => SENTENCE.test(part))) found.push(joined);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}
