/**
 * Workflow script source handling (pure).
 *
 * A workflow script is plain JavaScript that must begin with a pure-literal
 * `export const meta = {...}`. acorn parses the whole script once; the meta
 * literal is evaluated structurally (no code execution), the export statement
 * is spliced out, and the remainder is wrapped in an async IIFE behind a
 * prelude that makes wall-clock/randomness calls throw. The wrap is what makes
 * top-level `await` and bare top-level `return` work: both become ordinary
 * inside the IIFE.
 *
 * The vm context this produces code for is a determinism guard for resume
 * replay, not a security sandbox — the injected `agent()` does real work on
 * the host either way.
 */

import { parse } from "acorn";
import type { ScriptProblem, WorkflowResultText } from "./text.ts";
import { type WorkflowMeta, WorkflowScriptError } from "./types.ts";
import { workflowResultText } from "./text.ts";

const problem = (p: ScriptProblem) => new WorkflowScriptError(workflowResultText.scriptProblem(p));

/** Property keys that would let a "literal" reach into prototypes. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Names destructured off the injected `__workflow__` binding inside the vm. */
export const SCRIPT_GLOBALS = [
	"agent",
	"parallel",
	"pipeline",
	"workflow",
	"phase",
	"log",
	"console",
	"args",
	"budget",
] as const;

/** The guard the script runs behind: wall-clock and randomness calls throw, each with its message (text.ts). */
function determinismPrelude(words: WorkflowResultText["determinism"]): string {
	const say = (text: string) => JSON.stringify(text);
	return `
Math.random = () => { throw new Error(${say(words.random)}); };
globalThis.Date = new Proxy(Date, {
	construct(target, ctorArgs, newTarget) {
		if (ctorArgs.length === 0) throw new Error(${say(words.dateNoArgs)});
		return Reflect.construct(target, ctorArgs, newTarget);
	},
	apply() { throw new Error(${say(words.dateCall)}); },
	get(target, prop, receiver) {
		if (prop === "now") return () => { throw new Error(${say(words.dateNow)}); };
		return Reflect.get(target, prop, receiver);
	},
});
`;
}

export interface ParsedScript {
	meta: WorkflowMeta;
	/** Script source with the meta export spliced out. */
	body: string;
}

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

/** Structurally evaluate an object/array/primitive literal AST — no code runs. */
function evaluateLiteral(node: Node, path: string): unknown {
	switch (node.type) {
		case "Literal":
			return (node as { value?: unknown }).value;
		case "TemplateLiteral": {
			const expressions = node.expressions as Node[];
			const quasis = node.quasis as Array<{ value: { cooked?: string } }>;
			if (expressions.length > 0) {
				throw problem({ kind: "notLiteral", path, detail: "interpolation" });
			}
			return quasis.map((q) => q.value.cooked ?? "").join("");
		}
		case "UnaryExpression": {
			const operator = node.operator as string;
			const argument = node.argument as Node;
			const literal = (argument as { value?: unknown }).value;
			if (operator === "-" && argument.type === "Literal" && typeof literal === "number") {
				return -literal;
			}
			throw problem({ kind: "notLiteral", path, detail: "expression" });
		}
		case "ArrayExpression":
			return (node.elements as (Node | null)[]).map((el, i) => {
				if (!el) throw problem({ kind: "hole", path: `${path}[${i}]` });
				if (el.type === "SpreadElement") {
					throw problem({ kind: "notLiteral", path, detail: "spread" });
				}
				return evaluateLiteral(el, `${path}[${i}]`);
			});
		case "ObjectExpression": {
			const out: Record<string, unknown> = {};
			for (const prop of node.properties as Node[]) {
				if (prop.type !== "Property") {
					throw problem({ kind: "notLiteral", path, detail: "spreadOrMethod" });
				}
				if (prop.computed) {
					throw problem({ kind: "notLiteral", path, detail: "computedKey" });
				}
				const key = prop.key as Node;
				const name =
					key.type === "Identifier" ? (key.name as string) : key.type === "Literal" ? String((key as { value?: unknown }).value) : undefined;
				if (name === undefined) {
					throw problem({ kind: "notLiteral", path, detail: "key" });
				}
				if (FORBIDDEN_KEYS.has(name)) {
					throw problem({ kind: "forbiddenKey", path, key: name });
				}
				out[name] = evaluateLiteral(prop.value as Node, `${path}.${name}`);
			}
			return out;
		}
		default:
			throw problem({ kind: "notLiteral", path, detail: "other" });
	}
}

function validateMeta(value: unknown): WorkflowMeta {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw problem({ kind: "metaNotObject" });
	}
	const meta = value as Record<string, unknown>;
	if (typeof meta.name !== "string" || !meta.name.trim()) {
		throw problem({ kind: "metaField", field: "name" });
	}
	if (typeof meta.description !== "string" || !meta.description.trim()) {
		throw problem({ kind: "metaField", field: "description" });
	}
	if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") {
		throw problem({ kind: "metaField", field: "whenToUse" });
	}
	if (meta.phases !== undefined) {
		if (!Array.isArray(meta.phases)) throw problem({ kind: "metaField", field: "phases" });
		for (const phase of meta.phases) {
			if (typeof phase !== "object" || phase === null || typeof (phase as { title?: unknown }).title !== "string") {
				throw problem({ kind: "metaField", field: "phaseTitle" });
			}
		}
	}
	return meta as unknown as WorkflowMeta;
}

/** Parse a workflow script: lift + validate `meta`, splice its export out. */
export function parseWorkflowScript(source: string): ParsedScript {
	let ast: { body: Node[] };
	try {
		ast = parse(source, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
		}) as unknown as { body: Node[] };
	} catch (error) {
		throw problem({ kind: "parse", osMessage: (error as Error).message });
	}

	const first = ast.body[0];
	if (!first || first.type !== "ExportNamedDeclaration") {
		throw problem({ kind: "noMeta" });
	}
	const declaration = first.declaration as Node | null;
	if (!declaration || declaration.type !== "VariableDeclaration" || (declaration.kind as string) !== "const") {
		throw problem({ kind: "noMeta" });
	}
	const declarators = declaration.declarations as Node[];
	const declarator = declarators[0];
	if (
		declarators.length !== 1 ||
		(declarator.id as Node).type !== "Identifier" ||
		((declarator.id as Node).name as string) !== "meta"
	) {
		throw problem({ kind: "metaBinding" });
	}
	const init = declarator.init as Node | null;
	if (!init || init.type !== "ObjectExpression") {
		throw problem({ kind: "metaNotLiteral" });
	}

	for (const node of ast.body.slice(1)) {
		if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" || node.type === "ImportDeclaration") {
			throw problem({ kind: "importExport" });
		}
	}

	const meta = validateMeta(evaluateLiteral(init, "meta"));
	const body = source.slice(0, first.start) + source.slice(first.end);
	return { meta, body };
}

/**
 * Wrap a spliced script body for `vm.Script`. The async IIFE is the final
 * expression statement, so `runInContext()`'s completion value is the promise
 * of the script's own (possibly top-level-returned) result.
 */
export function wrapScriptBody(body: string): string {
	const bindings = SCRIPT_GLOBALS.join(", ");
	return `"use strict";\n${determinismPrelude(workflowResultText.determinism)}\nconst { ${bindings} } = __workflow__;\n(async () => {\n${body}\n})();`;
}
