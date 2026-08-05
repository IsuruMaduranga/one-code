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
import { type WorkflowMeta, WorkflowScriptError } from "./types.ts";

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

const DETERMINISM_PRELUDE = `
Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); vary agent prompts by index or pass randomness in via args"); };
globalThis.Date = new Proxy(Date, {
	construct(target, ctorArgs, newTarget) {
		if (ctorArgs.length === 0) throw new Error("new Date() with no arguments is unavailable in a workflow (it breaks resume); pass timestamps in via args");
		return Reflect.construct(target, ctorArgs, newTarget);
	},
	apply() { throw new Error("Date() is unavailable in a workflow (it breaks resume); pass timestamps in via args"); },
	get(target, prop, receiver) {
		if (prop === "now") return () => { throw new Error("Date.now() is unavailable in a workflow (it breaks resume); pass timestamps in via args"); };
		return Reflect.get(target, prop, receiver);
	},
});
`;

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
				throw new WorkflowScriptError(`\`${path}\` must be a pure literal: template interpolation is not allowed`);
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
			throw new WorkflowScriptError(`\`${path}\` must be a pure literal: unsupported expression`);
		}
		case "ArrayExpression":
			return (node.elements as (Node | null)[]).map((el, i) => {
				if (!el) throw new WorkflowScriptError(`\`${path}[${i}]\` must not be a hole`);
				if (el.type === "SpreadElement") {
					throw new WorkflowScriptError(`\`${path}\` must be a pure literal: spread is not allowed`);
				}
				return evaluateLiteral(el, `${path}[${i}]`);
			});
		case "ObjectExpression": {
			const out: Record<string, unknown> = {};
			for (const prop of node.properties as Node[]) {
				if (prop.type !== "Property") {
					throw new WorkflowScriptError(`\`${path}\` must be a pure literal: spread/methods are not allowed`);
				}
				if (prop.computed) {
					throw new WorkflowScriptError(`\`${path}\` must be a pure literal: computed keys are not allowed`);
				}
				const key = prop.key as Node;
				const name =
					key.type === "Identifier" ? (key.name as string) : key.type === "Literal" ? String((key as { value?: unknown }).value) : undefined;
				if (name === undefined) {
					throw new WorkflowScriptError(`\`${path}\` must be a pure literal: unsupported key`);
				}
				if (FORBIDDEN_KEYS.has(name)) {
					throw new WorkflowScriptError(`\`${path}\` must not contain the key "${name}"`);
				}
				out[name] = evaluateLiteral(prop.value as Node, `${path}.${name}`);
			}
			return out;
		}
		default:
			throw new WorkflowScriptError(`\`${path}\` must be a pure literal (objects, arrays, strings, numbers, booleans)`);
	}
}

function validateMeta(value: unknown): WorkflowMeta {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new WorkflowScriptError("`meta` must be an object literal");
	}
	const meta = value as Record<string, unknown>;
	if (typeof meta.name !== "string" || !meta.name.trim()) {
		throw new WorkflowScriptError("`meta.name` must be a non-empty string");
	}
	if (typeof meta.description !== "string" || !meta.description.trim()) {
		throw new WorkflowScriptError("`meta.description` must be a non-empty string");
	}
	if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") {
		throw new WorkflowScriptError("`meta.whenToUse` must be a string");
	}
	if (meta.phases !== undefined) {
		if (!Array.isArray(meta.phases)) throw new WorkflowScriptError("`meta.phases` must be an array");
		for (const phase of meta.phases) {
			if (typeof phase !== "object" || phase === null || typeof (phase as { title?: unknown }).title !== "string") {
				throw new WorkflowScriptError("each entry of `meta.phases` needs a `title` string");
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
		throw new WorkflowScriptError(`Workflow script does not parse: ${(error as Error).message}`);
	}

	const first = ast.body[0];
	if (!first || first.type !== "ExportNamedDeclaration") {
		throw new WorkflowScriptError("Workflow scripts must begin with `export const meta = {...}`");
	}
	const declaration = first.declaration as Node | null;
	if (!declaration || declaration.type !== "VariableDeclaration" || (declaration.kind as string) !== "const") {
		throw new WorkflowScriptError("Workflow scripts must begin with `export const meta = {...}`");
	}
	const declarators = declaration.declarations as Node[];
	const declarator = declarators[0];
	if (
		declarators.length !== 1 ||
		(declarator.id as Node).type !== "Identifier" ||
		((declarator.id as Node).name as string) !== "meta"
	) {
		throw new WorkflowScriptError("The first statement must export exactly one binding named `meta`");
	}
	const init = declarator.init as Node | null;
	if (!init || init.type !== "ObjectExpression") {
		throw new WorkflowScriptError("`meta` must be an object literal — no variables, calls, or spreads");
	}

	for (const node of ast.body.slice(1)) {
		if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" || node.type === "ImportDeclaration") {
			throw new WorkflowScriptError("Workflow scripts cannot use import/export beyond the leading `export const meta`");
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
	return `"use strict";\n${DETERMINISM_PRELUDE}\nconst { ${bindings} } = __workflow__;\n(async () => {\n${body}\n})();`;
}
