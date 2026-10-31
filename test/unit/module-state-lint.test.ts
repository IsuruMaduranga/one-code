/**
 * No session state at module scope (lifecycle-grid-hunt plan, part D). pi
 * evaluates an extension module again at a /reload and at a /resume into
 * another directory, and keeps it everywhere else (findings §8), so a
 * module-level value is lost on some lifecycle paths and kept on others.
 * State belongs to one of three kinds: branch state (a `one-code:state`
 * entry or a fold of the branch), process state (lib/process-state.ts) or a
 * resource that ends in `session_shutdown`. A module-scope `let`, or a
 * module-scope `const` that starts an empty `Map`, `Set`, array or object
 * (state filled in later), is allowed only for a cache of pure inputs or a
 * process resource, listed here with its reason, so each new one is a
 * reviewed decision. A lookup table written with its content passes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWED: Record<string, string> = {
	"extensions/auto-mode/history.ts provenanceMemo": "memo of a pure function of the transcript",
	"extensions/hooks/plugin-hooks.ts cache": "mtime cache of plugin hooks.json files",
	"extensions/hooks/settings.ts cache": "mtime cache of the hook settings files",
	"extensions/hooks/trust.ts pendingPrompts": "trust prompts in flight, shared by concurrent dispatches; the decisions are process state",
	"extensions/lib/anthropic-auth.ts authCache": "auth.json read, keyed by its mtime",
	"extensions/lib/atomic-write.ts sequence": "temp-file name counter, unique within the process",
	"extensions/lib/claude-rules.ts touched": "stat cache of rule files",
	"extensions/lib/claude-rules.ts matchers": "compiled glob matchers, a memo of pure inputs",
	"extensions/lib/claude-rules.ts walks": "rule-directory walks, reused while their stats match",
	"extensions/lib/model-catalog-data.ts bundled": "the bundled catalog, loaded once",
	"extensions/lib/model-catalog-data.ts memo": "memo of the catalog sources",
	"extensions/lib/model-catalog-data.ts pinned": "test pin of the catalog sources",
	"extensions/lib/model-catalog-data.ts inflight": "catalog refreshes in flight, shared by concurrent callers",
	"extensions/lib/model-tier.ts overrideMemo": "memo of the tier overrides file",
	"extensions/lib/model-tier.ts overridesPinned": "test pin of the tier overrides",
	"extensions/lib/process-tree.ts groupReaper": "process resource: the reaper timer for remembered groups",
	"extensions/lib/process-tree.ts exitHookInstalled": "process resource: one exit listener per module instance, each killing its own children",
	"extensions/lib/process-tree.ts rememberedGroups": "process resource: the groups the reaper and the signal listeners kill",
	"extensions/lib/process-tree.ts groupSignalHandlers": "process resource: one termination-signal listener per signal",
	"extensions/lib/process-tree.ts pendingKills": "process resource: trees sent SIGTERM whose SIGKILL is still due",
	"extensions/lib/shell-spawn.ts cachedBash": "the resolved bash binary",
	"extensions/lib/shell-spawn.ts cachedPowerShell": "the resolved PowerShell binary",
	"extensions/lib/worktree-isolation.ts active": "live isolation worktrees, registered and read inside one extension's import graph (file header)",
	"extensions/mcp/client.ts sdkPromise": "the MCP SDK, imported once",
	"extensions/mcp/client.ts unauthorizedClass": "a class from the SDK, resolved once",
	"extensions/mcp/client.ts httpErrorClass": "a class from the SDK, resolved once",
	"extensions/mcp/client.ts sseErrorClass": "a class from the SDK, resolved once",
	"extensions/mcp/trust.ts pendingPrompts": "trust prompts in flight, shared by concurrent callers; the decisions are process state",
	"extensions/permissions/powershell-rules.ts lastSplit": "memo of the last parsed line",
	"extensions/subagents/prose.ts ctorPromise": "a renderer class, imported once",
	"extensions/web-fetch/extract.ts libsPromise": "the reader libraries, imported once",
};

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (/\.(ts|mts)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

/** The expression under any `as`, `satisfies`, `<T>` or parentheses. */
function unwrap(expression: ts.Expression): ts.Expression {
	while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
	return expression;
}

/** An initializer that starts an empty mutable container: `new Map()`, `new Set()`, `[]` or `{}`. */
function emptyContainer(initializer: ts.Expression | undefined): boolean {
	if (!initializer) return false;
	const expression = unwrap(initializer);
	if (ts.isNewExpression(expression)) return ts.isIdentifier(expression.expression) && ["Map", "Set"].includes(expression.expression.text) && (expression.arguments?.length ?? 0) === 0;
	if (ts.isArrayLiteralExpression(expression)) return expression.elements.length === 0;
	if (ts.isObjectLiteralExpression(expression)) return expression.properties.length === 0;
	return false;
}

describe("module-scope state", () => {
	it("has no module-scope let or empty container outside the reviewed caches and resources", () => {
		const root = process.cwd();
		const found: string[] = [];
		for (const file of sources(join(root, "extensions"))) {
			const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
			for (const statement of source.statements) {
				if (!ts.isVariableStatement(statement)) continue;
				const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
				for (const declaration of statement.declarationList.declarations) {
					if (isLet || emptyContainer(declaration.initializer)) found.push(`${relative(root, file).split("\\").join("/")} ${declaration.name.getText(source)}`);
				}
			}
		}
		expect(found.filter((key) => !(key in ALLOWED))).toEqual([]);
		// A listed binding that is gone leaves a stale entry: remove it.
		expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
	});
});
