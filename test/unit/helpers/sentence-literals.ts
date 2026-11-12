/**
 * The sentence-like string literals in a TypeScript file, outside comments:
 * plain strings and template text with at least four words. The text moves
 * between the profile and the base are checked with it: the sentences a
 * move removes from one side are the ones it adds to the other.
 */
import ts from "typescript";

/** Four or more words of letters, the first one capitalized or not: prose, not an identifier, a path or a format. */
const SENTENCE = /[A-Za-z][A-Za-z'’]*(?:,?\s+[A-Za-z][A-Za-z'’]*){3,}/;

/** The text of every string and template literal in a file: comments, identifiers, module specifiers and type positions are not text. */
export function stringLiterals(source: string, fileName = "file.ts"): string[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, /\.m?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
		// A placeholder holds no letters, so it never joins two parts into one sentence.
		else if (ts.isTemplateExpression(node)) found.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${…}"));
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

export const sentenceLiterals = (source: string, fileName = "file.ts"): string[] => stringLiterals(source, fileName).filter((text) => SENTENCE.test(text));
