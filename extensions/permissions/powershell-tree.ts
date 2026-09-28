/**
 * The PowerShell pre-gate's verdicts, judged from PowerShell's own parse
 * (lib/powershell-parser.ts; decisions/windows.md "The PowerShell pre-gate
 * reads PowerShell's own parse"). Pure apart from the filesystem reads the
 * path checks make.
 *
 * Two verdicts, each positive proof only:
 *
 * - {@link powershellTreeReadOnly}: every statement is a pipeline of the read
 *   cmdlets in `powershell-cmdlets.ts`, called with parameters their tables
 *   clear, reading paths inside the working directory or a readable root.
 * - {@link powershellTreeContainedEdits}: every statement is one of Claude
 *   Code's acceptEdits cmdlets (`Set-Content`, `Add-Content`, `Remove-Item`,
 *   `Clear-Content`), optionally piped into an output tail, writing inside the
 *   working space. The caller offers it only where Claude Code's fast paths
 *   apply (frontier and workhorse models, acceptEdits and auto mode).
 *
 * Fail closed by construction: each check approves the nodes it has judged,
 * and a line with any node left unapproved (a syntax shape no check models) is
 * not cleared. The command names and parameters are PowerShell's resolution,
 * not ours: aliases are the running PowerShell's own (on macOS and Linux `ls`
 * is `/bin/ls`, not `Get-ChildItem`), and parameters are the static binder's
 * canonical names with positionals already placed.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isExecutionPrimitivePath, isSensitivePath } from "../auto-mode/sensitive.ts";
import { isWithin, resolveForContainment } from "../auto-mode/paths.ts";
import { touchesGuardedPath } from "../auto-mode/shell-analysis.ts";
import type { PowerShellAstNode, PowerShellParse } from "../lib/powershell-parser.ts";
import {
	type CmdletSpec,
	parameterKind,
	READ_APPLICATIONS,
	READ_CMDLETS,
	SELECT_STRING_SOURCES,
	TRUSTED_MODULES,
	WRITE_CMDLETS,
	WRITE_TAILS,
} from "./powershell-cmdlets.ts";
import { isProtectedPath } from "./protected-paths.ts";
import { powershellPathAbsolute, powershellPathProblem } from "./powershell-paths.ts";

export interface PowerShellTreeOptions {
	/** The working directory the command runs in. */
	cwd: string;
	home: string;
	/** REALPATH-resolved directories a read may point into besides the working directory (matcher.ts `sessionReadableRoots`). */
	readableRoots?: string[];
	/** REALPATH-resolved directories a write may land in besides the working directory (workspace directories). */
	writableRoots?: string[];
	/** Directories no write may touch (permissions/protected-paths.ts, the harness's own). */
	protectedDirs?: string[];
}

export interface PowerShellTreeVerdict {
	ok: boolean;
	/** Why not, for the decision log. */
	reason?: string;
}

/** The tree with each node's children, and the set of nodes a check has approved. */
interface Tree {
	nodes: PowerShellAstNode[];
	children: number[][];
	approved: Set<number>;
}

class Refusal extends Error {}

function refuse(reason: string): never {
	throw new Refusal(reason);
}

function buildTree(parse: PowerShellParse): Tree {
	const children: number[][] = parse.nodes.map(() => []);
	parse.nodes.forEach((node, i) => {
		if (node.parent >= 0 && node.parent < i) children[node.parent].push(i);
	});
	return { nodes: parse.nodes, children, approved: new Set() };
}

/** The top-level pipelines of the line, each as its CommandAst node indices in order. Refuses anything that is not a plain pipeline or chain of them. */
function pipelines(tree: Tree): number[][] {
	const { nodes, children } = tree;
	if (nodes[0]?.type !== "ScriptBlockAst") refuse("the line did not parse as a script");
	tree.approved.add(0);
	const blocks = children[0];
	if (blocks.length !== 1 || nodes[blocks[0]].type !== "NamedBlockAst") refuse("a param block, using statement or named block");
	tree.approved.add(blocks[0]);
	const result: number[][] = [];
	const statement = (i: number) => {
		const node = nodes[i];
		if (node.type === "PipelineChainAst") {
			if (node.background) refuse("a background job (`&`)");
			tree.approved.add(i);
			for (const side of children[i]) statement(side);
			return;
		}
		if (node.type !== "PipelineAst") refuse(`${aNode(node.type)} statement`);
		if (node.background) refuse("a background job (`&`)");
		tree.approved.add(i);
		const elements = children[i];
		for (const element of elements) {
			if (nodes[element].type !== "CommandAst") refuse("an expression as a pipeline source, whose value this check cannot see");
		}
		result.push(elements);
	};
	for (const i of children[blocks[0]]) statement(i);
	if (result.length === 0) refuse("empty command");
	return result;
}

/** A node type as words: `InvokeMemberExpressionAst` is "invoke member expression". */
function statementName(type: string): string {
	return type.replace(/(Statement)?Ast$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** "a" or "an" before a node type's words. */
function aNode(type: string): string {
	const words = statementName(type);
	return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
}

/** The constant strings a value node holds, approving it, or undefined when it is not a constant. */
function constantValues(tree: Tree, i: number): string[] | undefined {
	const node = tree.nodes[i];
	if (node.type === "StringConstantExpressionAst" || node.type === "ConstantExpressionAst") {
		if (tree.children[i].length > 0) return undefined;
		tree.approved.add(i);
		return [node.value ?? ""];
	}
	if (node.type === "ArrayLiteralAst") {
		const values: string[] = [];
		for (const child of tree.children[i]) {
			const inner = constantValues(tree, child);
			if (inner === undefined) return undefined;
			values.push(...inner);
		}
		tree.approved.add(i);
		return values;
	}
	return undefined;
}

const SAFE_VARIABLES = new Set(["_", "psitem", "true", "false", "null"]);

/** Binary operators a checked script block may use: comparison, logic, arithmetic and string operators. No range (`..`), `-as` or `-is` (types). */
const SAFE_BINARY = new Set(
	[
		...["eq", "ne", "ge", "gt", "lt", "le", "like", "notlike", "match", "notmatch", "replace", "contains", "notcontains", "in", "notin", "split"].flatMap((op) => [`I${op}`, `C${op}`]),
		"And",
		"Or",
		"Xor",
		"Join",
		"Plus",
		"Minus",
		"Multiply",
		"Divide",
		"Rem",
		"Format",
	].map((op) => op.toLowerCase()),
);
const SAFE_UNARY = new Set(["not", "exclaim", "minus", "plus"]);

/**
 * A script block that only reads `$_` and compares: `{ $_.Length -gt 1kb }`,
 * `{ $_.Name }`. No command, method call, assignment, variable other than
 * `$_`, type or dynamic member name.
 */
function checkScriptBlock(tree: Tree, i: number): void {
	const { nodes, children } = tree;
	if (nodes[i].type !== "ScriptBlockExpressionAst") refuse("a script block this check cannot read");
	const block = children[i];
	if (block.length !== 1 || nodes[block[0]].type !== "ScriptBlockAst") refuse("a script block this check cannot read");
	const named = children[block[0]];
	if (named.length !== 1 || nodes[named[0]].type !== "NamedBlockAst") refuse("a script block with a param or named block");
	tree.approved.add(i).add(block[0]).add(named[0]);
	for (const statement of children[named[0]]) checkExpressionStatement(tree, statement);
}

/** A pipeline of exactly one expression, the only statement a checked script block or parenthesis may hold. */
function checkExpressionStatement(tree: Tree, i: number): void {
	const { nodes, children } = tree;
	if (nodes[i].type !== "PipelineAst" || children[i].length !== 1 || nodes[children[i][0]].type !== "CommandExpressionAst") {
		refuse("a script block that runs a command");
	}
	const expression = children[i][0];
	if (children[expression].length !== 1) refuse("a redirection inside a script block");
	tree.approved.add(i).add(expression);
	checkExpression(tree, children[expression][0]);
}

function checkExpression(tree: Tree, i: number): void {
	const { nodes, children } = tree;
	const node = nodes[i];
	switch (node.type) {
		case "StringConstantExpressionAst":
		case "ConstantExpressionAst":
			if (children[i].length === 0) {
				tree.approved.add(i);
				return;
			}
			break;
		case "VariableExpressionAst":
			if (!node.splatted && SAFE_VARIABLES.has((node.name ?? "").toLowerCase())) {
				tree.approved.add(i);
				return;
			}
			refuse("a variable other than $_ in a script block");
			break;
		case "MemberExpressionAst": {
			const [target, member] = children[i];
			if (node.static || nodes[member]?.type !== "StringConstantExpressionAst") refuse("a static or computed member access");
			tree.approved.add(i).add(member);
			checkExpression(tree, target);
			return;
		}
		case "BinaryExpressionAst":
			if (!SAFE_BINARY.has((node.operator ?? "").toLowerCase())) refuse(`the -${node.operator} operator in a script block`);
			tree.approved.add(i);
			for (const child of children[i]) checkExpression(tree, child);
			return;
		case "UnaryExpressionAst":
			if (!SAFE_UNARY.has((node.operator ?? "").toLowerCase())) refuse(`the ${node.operator} operator in a script block`);
			tree.approved.add(i);
			for (const child of children[i]) checkExpression(tree, child);
			return;
		case "ParenExpressionAst":
			if (children[i].length !== 1) break;
			tree.approved.add(i);
			checkExpressionStatement(tree, children[i][0]);
			return;
		case "ArrayLiteralAst":
			tree.approved.add(i);
			for (const child of children[i]) checkExpression(tree, child);
			return;
	}
	refuse(`${aNode(node.type)} in a script block`);
}

/** One command whose name, bindings and elements are checked; returns its lowercase canonical name and the path values it binds. */
interface CheckedCommand {
	name: string;
	/** The values of its path parameters. */
	paths: string[];
	/** The canonical names of every parameter it binds. */
	bound: Set<string>;
}

type SpecFor = (name: string) => CmdletSpec | undefined;

/**
 * Check one CommandAst: a static name that resolves to a PowerShell cmdlet in
 * `specFor`'s table (or a read-only application, when `applications` is set),
 * called with parameters the table clears, holding constant values, with no
 * redirection except to `$null` or a stream merge.
 */
function checkCommand(tree: Tree, i: number, specFor: SpecFor, applications: boolean): CheckedCommand {
	const { nodes, children } = tree;
	const node = nodes[i];
	if (node.operator && node.operator !== "Unknown") refuse("the call (&) or dot-source operator");
	if (!node.name) refuse("a command name computed at run time");
	const elements = children[i];
	const nameElement = elements[0];
	if (nameElement === undefined || nodes[nameElement].type !== "StringConstantExpressionAst") refuse("a command name computed at run time");
	tree.approved.add(i).add(nameElement);
	const shown = node.name;

	for (const element of elements.slice(1)) checkRedirection(tree, element);

	if (node.commandType === "Application" && applications && READ_APPLICATIONS.has(shown.toLowerCase())) {
		const paths: string[] = [];
		for (const element of elements.slice(1)) {
			if (nodes[element].type.endsWith("RedirectionAst")) continue;
			const values = constantValues(tree, element);
			if (values === undefined) refuse(`an argument to ${shown} this check cannot read`);
			paths.push(...values);
		}
		return { name: shown.toLowerCase(), paths, bound: new Set() };
	}
	if (node.commandType !== "Cmdlet" || !TRUSTED_MODULES.has((node.module ?? "").toLowerCase()) || !node.resolvedName) {
		refuse(node.commandType ? `\`${shown}\` is not a read-only cmdlet` : `\`${shown}\` is not a command this PowerShell knows`);
	}
	const name = node.resolvedName.toLowerCase();
	const spec = specFor(name);
	if (!spec) refuse(`\`${node.resolvedName}\` is not a cmdlet this check clears here`);
	if (node.bindingUnavailable) refuse("PowerShell's parameter binder is not available");
	if ((node.bindingErrors ?? []).length > 0) refuse(`an argument PowerShell cannot bind to ${node.resolvedName}`);

	const paths: string[] = [];
	const bound = new Set<string>();
	for (const binding of node.bindings ?? []) {
		const kind = parameterKind(spec, binding.parameter);
		if (!kind) refuse(`-${binding.parameter} is not a parameter this check clears for ${node.resolvedName}`);
		bound.add(binding.parameter.toLowerCase());
		if (binding.value === -1) {
			if (kind !== "switch") refuse(`-${binding.parameter} without a value`);
			continue;
		}
		if (kind === "switch") {
			const value = nodes[binding.value];
			if (value?.type !== "VariableExpressionAst" || !["true", "false"].includes((value.name ?? "").toLowerCase())) refuse(`-${binding.parameter} given a value that is not $true or $false`);
			tree.approved.add(binding.value);
			continue;
		}
		if (kind === "scriptBlock" && nodes[binding.value]?.type === "ScriptBlockExpressionAst") {
			checkScriptBlock(tree, binding.value);
			continue;
		}
		const values = binding.value === -2 ? collectedValues(tree, binding.elements) : constantValues(tree, binding.value);
		if (values === undefined) refuse(`-${binding.parameter} given a value computed at run time`);
		if (kind === "path") paths.push(...values);
	}
	// A parameter given `$false` binds nothing (the binder drops it, as
	// PowerShell does: the switch is off); its argument is still a constant.
	for (const element of elements.slice(1)) {
		if (nodes[element].type !== "CommandParameterAst") continue;
		tree.approved.add(element);
		for (const argument of children[element]) {
			const value = nodes[argument];
			if (!tree.approved.has(argument) && value.type === "VariableExpressionAst" && (value.name ?? "").toLowerCase() === "false") tree.approved.add(argument);
		}
	}
	return { name, paths, bound };
}

/** The constants a remaining-arguments parameter collected, each an argument of the command. */
function collectedValues(tree: Tree, elements: number[] | undefined): string[] | undefined {
	if (!elements || elements.length === 0 || elements.some((i) => i < 0)) return undefined;
	const values: string[] = [];
	for (const element of elements) {
		const inner = constantValues(tree, element);
		if (inner === undefined) return undefined;
		values.push(...inner);
	}
	return values;
}

/** A stream merge (`2>&1`) and a redirection to `$null` write no file; any other redirection is not cleared. */
function checkRedirection(tree: Tree, i: number): void {
	const { nodes, children } = tree;
	const node = nodes[i];
	if (node.type === "MergingRedirectionAst") {
		tree.approved.add(i);
		return;
	}
	if (node.type !== "FileRedirectionAst") return;
	const [location] = children[i];
	if (children[i].length === 1 && nodes[location].type === "VariableExpressionAst" && (nodes[location].name ?? "").toLowerCase() === "null") {
		tree.approved.add(i).add(location);
		return;
	}
	refuse("a redirection that writes a file");
}

function readRoots(opts: PowerShellTreeOptions): string[] {
	return [resolveForContainment(opts.cwd) ?? opts.cwd, ...(opts.readableRoots ?? [])];
}

/** Every node must have been approved by a check; the first one left over names what was not modelled. */
function requireAllApproved(tree: Tree): void {
	for (let i = 0; i < tree.nodes.length; i++) {
		if (!tree.approved.has(i)) refuse(`${aNode(tree.nodes[i].type)} this check does not model`);
	}
}

function verdict(judge: () => void): PowerShellTreeVerdict {
	try {
		judge();
		return { ok: true };
	} catch (error) {
		if (error instanceof Refusal) return { ok: false, reason: error.message };
		throw error;
	}
}

/** The most entries a directory may hold for its entries to be checked one by one. */
const ENTRY_LIMIT = 2_000;

/** The most entries a recursive walk looks at before it gives up (and the caller refuses). */
const WALK_LIMIT = 5_000;

/**
 * Whether the tree under `directory` holds a symbolic link or junction, or
 * is too large to walk. Windows PowerShell 5.1's recursive `Get-ChildItem`
 * and `Remove-Item` follow them (PowerShell 7's do not), so a link deep in
 * the tree lists or deletes what it points at, which the target's own
 * containment check never sees.
 */
function linkInTree(directory: string): boolean {
	const stack = [directory];
	let seen = 0;
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > WALK_LIMIT || entry.isSymbolicLink()) return true;
			if (entry.isDirectory()) stack.push(join(current, entry.name));
		}
	}
	return false;
}

/** Whether every entry of `directory` (not recursing) resolves inside a root and to no credential path. */
function entriesInside(directory: string, roots: string[]): boolean {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return true; // nothing to read through
	}
	if (entries.length > ENTRY_LIMIT) return false;
	for (const entry of entries) {
		const resolved = resolveForContainment(join(directory, entry));
		if (resolved === undefined || !roots.some((root) => isWithin(root, resolved)) || isSensitivePath(resolved)) return false;
	}
	return true;
}

/**
 * Whether every statement of the line only reads inside the working directory
 * and the readable roots. See the module header.
 */
export function powershellTreeReadOnly(parse: PowerShellParse, opts: PowerShellTreeOptions): PowerShellTreeVerdict {
	return verdict(() => {
		if (parse.errors.length > 0) refuse("PowerShell could not parse the line");
		const tree = buildTree(parse);
		const roots = readRoots(opts);
		for (const pipeline of pipelines(tree)) {
			const checked: CheckedCommand[] = [];
			pipeline.forEach((command, position) => {
				const current = checkCommand(tree, command, (name) => READ_CMDLETS[name], true);
				const spec = READ_CMDLETS[current.name];
				if (position > 0 && spec && !spec.tail) refuse(`\`${tree.nodes[command].resolvedName}\` after a pipe reads the paths its input names`);
				if (position > 0 && current.name === "select-string") checkSelectStringSources(checked, opts, roots);
				if (current.name === "get-childitem" && (current.bound.has("recurse") || current.bound.has("depth"))) {
					for (const directory of current.paths.length > 0 ? current.paths : ["."]) {
						const absolute = /[*?[]/.test(directory) ? undefined : powershellPathAbsolute(directory, opts);
						const resolved = absolute === undefined ? undefined : resolveForContainment(absolute);
						if (resolved === undefined || linkInTree(resolved)) refuse("a recursive Get-ChildItem over a tree with a link in it, which Windows PowerShell 5.1 follows");
					}
				}
				for (const path of current.paths) {
					const problem = powershellPathProblem(path, opts, roots);
					if (problem) refuse(problem);
				}
				checked.push(current);
			});
		}
		requireAllApproved(tree);
	});
}

/**
 * `Select-String` after a pipe reads the file behind each `FileInfo` it
 * receives. Its sources must be cmdlets whose output is text or a real
 * file object; a `Get-ChildItem` among them must not recurse (a link deep in
 * the tree is never seen), and every entry it lists must resolve inside.
 */
function checkSelectStringSources(upstream: CheckedCommand[], opts: PowerShellTreeOptions, roots: string[]): void {
	for (const source of upstream) {
		if (!SELECT_STRING_SOURCES.has(source.name)) refuse(`Select-String after \`${source.name}\`, whose output can name any file`);
		if (source.name !== "get-childitem") continue;
		if (source.bound.has("recurse") || source.bound.has("depth")) {
			refuse("Select-String over a recursive Get-ChildItem, which reads through links inside the tree");
		}
		const directories = source.paths.length > 0 ? source.paths : ["."];
		for (const directory of directories) {
			if (/[*?[]/.test(directory)) continue; // a wildcard lists its matches, each judged as a path already
			const absolute = powershellPathAbsolute(directory, opts);
			const resolved = absolute === undefined ? undefined : resolveForContainment(absolute);
			if (resolved === undefined || !entriesInside(resolved, roots)) refuse("Select-String over a directory with an entry outside the working directory");
		}
	}
}

/**
 * Whether every statement of the line is one of Claude Code's acceptEdits
 * cmdlets writing inside the working space, optionally piped into an output
 * tail. See the module header.
 */
export function powershellTreeContainedEdits(parse: PowerShellParse, opts: PowerShellTreeOptions): PowerShellTreeVerdict {
	return verdict(() => {
		if (parse.errors.length > 0) refuse("PowerShell could not parse the line");
		const tree = buildTree(parse);
		const root = resolveForContainment(opts.cwd) ?? opts.cwd;
		const writable = [root, ...(opts.writableRoots ?? [])];
		for (const pipeline of pipelines(tree)) {
			pipeline.forEach((command, position) => {
				const current = checkCommand(tree, command, (name) => (position === 0 ? WRITE_CMDLETS[name] : WRITE_TAILS.has(name) ? READ_CMDLETS[name] : undefined), false);
				if (position > 0) return;
				if (current.paths.length === 0) refuse(`${tree.nodes[command].resolvedName} without a path`);
				const removes = current.name === "remove-item";
				for (const path of current.paths) checkWriteTarget(path, removes, removes && current.bound.has("recurse"), opts, root, writable);
			});
		}
		requireAllApproved(tree);
	});
}

/**
 * The bash gate's write-target check (shell-analysis.ts `checkWriteTarget`),
 * for a PowerShell path: resolved inside the working space, and not a
 * credential, execution-primitive or protected path. A removal must not take
 * a working root, a `.git`, or a directory holding one or a guarded path,
 * and a recursive removal must not reach a link.
 */
function checkWriteTarget(value: string, removes: boolean, recurses: boolean, opts: PowerShellTreeOptions, root: string, writable: string[]): void {
	if (/[*?[\]]/.test(value)) refuse(`writes to ${value}, a wildcard whose matches this check does not judge`);
	const absolute = powershellPathAbsolute(value, opts);
	if (absolute === undefined) refuse(`writes to ${value}, a path this check cannot resolve`);
	const resolved = resolveForContainment(absolute);
	if (resolved === undefined || !writable.some((dir) => isWithin(dir, resolved))) refuse(`writes to ${value}, which is outside the working directory`);
	const guarded = (path: string) =>
		isSensitivePath(path) ||
		isExecutionPrimitivePath(path) ||
		isProtectedPath(path, opts.cwd) ||
		(opts.protectedDirs ?? []).some((dir) => isWithin(dir, path));
	if ([absolute, resolved].some(guarded)) refuse(`writes to ${value}, a credential, execution-primitive or protected path`);
	if (!removes) return;
	const lost = (path: string) => path.split(/[\\/]/).includes(".git") || guarded(path);
	if (resolved === root || writable.includes(resolved) || lost(absolute) || lost(resolved) || touchesGuardedPath(resolved, resolved, lost)) {
		refuse(`removes ${value}, which is a working root, or is or holds a git repository or a protected, credential or execution-primitive path`);
	}
	if (recurses && linkInTree(resolved)) refuse(`removes ${value} recursively, and a link inside it would be followed by Windows PowerShell 5.1`);
}
