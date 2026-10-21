/**
 * No session state at module scope (lifecycle-grid-hunt plan, part D). pi
 * evaluates an extension module again at a /reload and at a /resume into
 * another directory, and keeps it everywhere else (findings §8), so a
 * module-level value is lost on some lifecycle paths and kept on others.
 * State belongs to one of three kinds: branch state (a `one-code:state`
 * entry or a fold of the branch), process state (lib/process-state.ts) or a
 * resource that ends in `session_shutdown`. A module-scope `let` is allowed
 * only for a cache of pure inputs or a process resource, listed here with
 * its reason, so each new one is a reviewed decision.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWED: Record<string, string> = {
	"extensions/auto-mode/history.ts provenanceMemo": "memo of a pure function of the transcript",
	"extensions/lib/anthropic-auth.ts authCache": "auth.json read, keyed by its mtime",
	"extensions/lib/atomic-write.ts sequence": "temp-file name counter, unique within the process",
	"extensions/lib/claude-rules.ts touched": "stat cache of rule files",
	"extensions/lib/model-catalog-data.ts bundled": "the bundled catalog, loaded once",
	"extensions/lib/model-catalog-data.ts memo": "memo of the catalog sources",
	"extensions/lib/model-catalog-data.ts pinned": "test pin of the catalog sources",
	"extensions/lib/model-tier.ts overrideMemo": "memo of the tier overrides file",
	"extensions/lib/model-tier.ts overridesPinned": "test pin of the tier overrides",
	"extensions/lib/process-tree.ts groupReaper": "process resource: the reaper timer for remembered groups",
	"extensions/lib/process-tree.ts exitHookInstalled": "process resource: one exit listener per module instance, each killing its own children",
	"extensions/lib/shell-spawn.ts cachedBash": "the resolved bash binary",
	"extensions/lib/shell-spawn.ts cachedPowerShell": "the resolved PowerShell binary",
	"extensions/mcp/client.ts sdkPromise": "the MCP SDK, imported once",
	"extensions/mcp/client.ts unauthorizedClass": "a class from the SDK, resolved once",
	"extensions/mcp/client.ts httpErrorClass": "a class from the SDK, resolved once",
	"extensions/mcp/client.ts sseErrorClass": "a class from the SDK, resolved once",
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

describe("module-scope state", () => {
	it("has no module-scope let outside the reviewed caches and resources", () => {
		const root = process.cwd();
		const found: string[] = [];
		for (const file of sources(join(root, "extensions"))) {
			const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
			for (const statement of source.statements) {
				if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Let) === 0) continue;
				for (const declaration of statement.declarationList.declarations) found.push(`${relative(root, file).split("\\").join("/")} ${declaration.name.getText(source)}`);
			}
		}
		expect(found.filter((key) => !(key in ALLOWED))).toEqual([]);
		// A listed binding that is gone leaves a stale entry: remove it.
		expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
	});
});
