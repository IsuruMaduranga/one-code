/**
 * Every module under `extensions/` and `profile/` that starts a child process
 * says how that process ends, so a new spawner cannot leave processes behind
 * unnoticed (test/e2e/exit-probe.mjs checks the running harness; this checks
 * the source). A module is a spawner when it imports a spawning function from
 * `node:child_process`, or calls a wrapper that starts a process and hands its
 * lifetime to the caller (SPAWNING_WRAPPERS).
 *
 * Each spawner is declared:
 *
 * - `awaited`: short-lived; the caller waits for it (a synchronous call,
 *   `waitForChildExit`, a promisified call or a callback) and bounds it with a
 *   timeout or a kill on abort.
 * - `registered`: long-lived; started with `spawnOwnedTree`
 *   (lib/shell-run/process-tree.ts), which spawns it in its own group and
 *   remembers the group, so the exit and signal hooks there end it with the
 *   process, and stopped through the tree it returns. process-tree.ts does
 *   not export the parts (remembering a group, a stop with its grace), so no
 *   module can own a tree by hand: one helper keeps one stop policy, where
 *   hand-written copies drifted apart (a language server's launcher once
 *   exited without ending the rest of its group).
 * - `exception`: neither, with the reason. The list only shrinks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..");

type Lifetime = { kind: "awaited" | "registered" | "exception"; how: string };

const SPAWNERS: Record<string, Lifetime> = {
	"extensions/context/instructions/index.ts": { kind: "awaited", how: "`git config user.email`, synchronous" },
	"extensions/context/memory/open-external.ts": { kind: "exception", how: "opens the user's editor or file manager, detached and unref'd: it is meant to outlive One Code" },
	"extensions/lib/agents/agent-worktree.ts": { kind: "awaited", how: "git, promisified" },
	"extensions/lib/context/git-status.ts": { kind: "awaited", how: "git, synchronous with a timeout" },
	"extensions/lib/context/git.ts": { kind: "awaited", how: "git, with a timeout" },
	"extensions/lib/shell-run/bash-background.ts": {
		kind: "registered",
		how: "background shells and monitors (spawnOwnedShell): an owned tree, stopped on task_stop, the timeout or the deadline; a finished shell's leftovers live until the process exits",
	},
	"extensions/lib/shell-run/process-tree.ts": {
		kind: "exception",
		how: "the kills themselves: taskkill.exe, unref'd, ends on its own; the exit watchdog SIGKILLs what outlasts SIGTERM and exits within KILL_GRACE_MS",
	},
	"extensions/lib/shell-run/sandbox-probe.ts": { kind: "awaited", how: "one trial command at the Linux sandbox's start: waitForChildExit with a timeout that kills its group" },
	"extensions/lib/shell-run/shell-spawn.ts": {
		kind: "exception",
		how: "defines spawnShellCommand (its callers own the lifetime); the PowerShell tool's operations are awaited; the PowerShell parser server lives in pi's own group, unref'd, and ends when its stdin closes",
	},
	"extensions/lib/ui/open-browser.ts": { kind: "exception", how: "opens the user's browser, detached and unref'd: it is meant to outlive One Code" },
	"extensions/safety/hooks/executor.ts": { kind: "awaited", how: "waitForChildExit with a timeout that kills the hook's group; a SessionEnd hook is fire-and-forget by design" },
	"extensions/safety/permissions/auto-mode/setup-run.ts": { kind: "awaited", how: "probe commands with a timeout" },
	"extensions/safety/worktree/index.ts": { kind: "awaited", how: "git, promisified" },
	"extensions/tools/bash/index.ts": { kind: "awaited", how: "pi's bash tool waits for its command and kills the tree on abort or timeout" },
	"extensions/tools/lsp/client.ts": { kind: "registered", how: "language servers: an owned tree, killed on stop, the group ended when its launcher exits" },
	"extensions/tools/mcp/stdio-transport.ts": { kind: "registered", how: "stdio MCP servers: an owned tree, stopped on close, the group ended when its launcher exits" },
	"extensions/tools/plugins/marketplace/git.ts": { kind: "awaited", how: "git, with a timeout" },
	"extensions/tools/plugins/shell-expand.ts": { kind: "awaited", how: "waitForChildExit with a timeout that kills the group" },
	"extensions/ui/footer/pr.ts": { kind: "awaited", how: "gh, with a timeout" },
};

const CHILD_PROCESS = new Set(["node:child_process", "child_process"]);
const SPAWN_FUNCTIONS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
/** Functions and classes that start a process and leave its lifetime to the caller. */
const SPAWNING_WRAPPERS = new Set(["spawnShellCommand", "createLocalBashOperations", "createBashToolDefinition"]);

/** What in `source` starts a process: the child_process functions it imports and the wrappers it calls. */
function spawnsIn(source: string, path: string): string[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const found = new Set<string>();
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS.has(node.moduleSpecifier.text)) {
			const clause = node.importClause;
			if (clause && !clause.isTypeOnly) {
				if (clause.name) found.add("child_process (default import)");
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) found.add("child_process (namespace import)");
				if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						const name = (element.propertyName ?? element.name).text;
						if (!element.isTypeOnly && SPAWN_FUNCTIONS.has(name)) found.add(name);
					}
				}
			}
		} else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const callee = node.expression;
			const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
			if (name && SPAWNING_WRAPPERS.has(name)) found.add(name);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return [...found].sort();
}

/** Whether the module's text shows the lifetime it declares. */
function showsLifetime(kind: Lifetime["kind"], source: string): boolean {
	if (kind === "registered") return source.includes("spawnOwnedTree(");
	if (kind === "awaited") return /waitForChildExit\(|timeout|promisify\(|Sync\(|create(Local)?Bash(Operations|ToolDefinition)\(/.test(source);
	return true;
}

/** How to start a long-lived child: the fix every `registered` failure names. */
const OWNED_TREE_FIX =
	"start it with spawnOwnedTree((detached) => spawn(…, { …, ...detached })) from lib/shell-run/process-tree.ts and end it through the tree it returns (tree.stop(KILL_GRACE_MS), tree.kill(signal)); pass { endGroupWithLauncher: true } when the child is a launcher whose exit should end the rest of its group";

const FIX =
	"declare it in SPAWNERS in test/unit/process-spawners.test.ts: `awaited` (short-lived: wait for it with waitForChildExit or a promisified call, bound it with a timeout, kill it with killProcessTree on abort) or `registered` (long-lived: " +
	OWNED_TREE_FIX +
	"); see lib/shell-run/process-tree.ts and decisions/tools.md \"Nothing outlives its session\"";

/**
 * The one part of an owned tree process-tree.ts still exports (for its Windows
 * test): a module asks the tree it holds (`tree.alive()`), never the group.
 */
const TREE_PART = "rememberedGroupAlive(";
const PROCESS_TREE = "extensions/lib/shell-run/process-tree.ts";

describe("modules that start child processes", () => {
	const spawners = new Map<string, string[]>();
	const sources = new Map<string, string>();
	for (const dir of ["extensions", "profile"]) {
		for (const file of sourceFiles(join(ROOT, dir), ROOT)) {
			if (file.includes("/test/")) continue;
			const source = readFileSync(join(ROOT, file), "utf8");
			const found = spawnsIn(source, file);
			if (found.length > 0) {
				spawners.set(file, found);
				sources.set(file, source);
			}
		}
	}

	it("finds the spawners (the scan works)", () => {
		expect(spawners.get("extensions/tools/lsp/client.ts")).toEqual(["spawn"]);
		expect(spawners.get("extensions/lib/shell-run/bash-background.ts")).toEqual(["spawnShellCommand"]);
	});

	it("declares how every spawner's processes end", () => {
		const undeclared = [...spawners].filter(([file]) => !SPAWNERS[file]).map(([file, found]) => `${file} starts processes (${found.join(", ")}): ${FIX}`);
		expect(undeclared).toEqual([]);
	});

	it("declares no module that no longer spawns", () => {
		expect(Object.keys(SPAWNERS).filter((file) => !spawners.has(file))).toEqual([]);
	});

	it("shows the declared lifetime in each module", () => {
		const unshown = Object.entries(SPAWNERS)
			.filter(([file, { kind }]) => sources.has(file) && !showsLifetime(kind, sources.get(file)!))
			.map(([file, { kind }]) =>
				kind === "registered" ? `${file} is declared registered but never calls spawnOwnedTree(): ${OWNED_TREE_FIX}` : `${file} is declared ${kind} but shows no wait or bound on its child`,
			);
		expect(unshown).toEqual([]);
	});

	it("asks an owned tree whether it is alive, never its group by hand", () => {
		const byHand: string[] = [];
		for (const dir of ["extensions", "profile"]) {
			for (const file of sourceFiles(join(ROOT, dir), ROOT)) {
				if (file === PROCESS_TREE || file.includes("/test/")) continue;
				if (readFileSync(join(ROOT, file), "utf8").includes(TREE_PART)) byHand.push(`${file} calls ${TREE_PART}) by hand: ${OWNED_TREE_FIX}, and ask it tree.alive()`);
			}
		}
		expect(byHand).toEqual([]);
	});

	it("keeps the declarations sorted", () => {
		const files = Object.keys(SPAWNERS);
		expect(files).toEqual([...files].sort());
	});
});
