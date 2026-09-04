import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { piDist, piRoot, repoRoot } from "./helpers/pi-install.ts";

/**
 * The bundled app imports pi as a LIBRARY (`app/bin.mjs` does
 * `await import("@earendil-works/pi-coding-agent")` for InteractiveMode,
 * AssistantMessageComponent and main). That loads pi's unbundled `dist/`
 * tree, not the `dist/bundle/` one its own `bin` uses — so every bare package
 * pi statically imports on that path must be resolvable from the APP's
 * dependency tree.
 *
 * pi 0.85.0 shipped one that is not: `dist/index.js` re-exports `main` from
 * `main.js`, which imports `experimental/server.js`, which imports
 * `@earendil-works/pi-server` — a package published on npm but absent from
 * pi's own `dependencies` and `npm-shrinkwrap.json`. pi's CLI never notices
 * (its bundle inlines that code), and neither does `tsc` (types resolve
 * without evaluating the graph), so a clean `npm i -g @one-ai/one-code` would
 * have crashed on launch for every user. Reproduced in an isolated install
 * 2026-09-04; findings §6.
 *
 * This walks the real static import graph from pi's library entry and asserts
 * every `@earendil-works/*` package it reaches is declared by pi itself or,
 * failing that, carried by `app/package.json` at pi's exact version.
 */
const piPackage = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")) as {
	version: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};
const appPackage = JSON.parse(readFileSync(join(repoRoot, "app", "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
};

const SCOPE = "@earendil-works/";
/** Packages pi declares for itself, so the app need not carry them. */
const piDeclares = { ...piPackage.dependencies, ...piPackage.optionalDependencies };

interface ModuleNode {
	type: string;
	source?: { value?: unknown };
}

/**
 * Specifiers one module pulls in at LOAD time: `import`, `export … from` and
 * `export * from`. Parsed with acorn (already a dependency, and the tool
 * `extensions/workflow/script-source.ts` uses for the same job) rather than
 * matched by regex, so text inside a comment or string cannot pose as an
 * import. `import()` is deliberately excluded — a dynamic import does not run
 * at load time, so it cannot break the initial import the way this bug did,
 * and acorn gives it a node type of its own.
 */
function staticSpecifiers(source: string): string[] {
	const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as { body: ModuleNode[] };
	const specifiers: string[] = [];
	for (const node of ast.body) {
		if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;
		// A local `export { x }` has no source; only re-exports carry one.
		if (typeof node.source?.value === "string") specifiers.push(node.source.value);
	}
	return specifiers;
}

/** Bare `@earendil-works/*` packages reachable by static import from `entry`. */
function reachableScopedPackages(entry: string): Set<string> {
	const packages = new Set<string>();
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue; // a specifier we cannot resolve to a file is not our concern here
		}
		for (const specifier of staticSpecifiers(source)) {
			if (specifier.startsWith(".")) {
				queue.push(resolve(dirname(file), specifier));
				continue;
			}
			if (!specifier.startsWith(SCOPE)) continue;
			// "@scope/pkg/subpath" → "@scope/pkg"
			packages.add(specifier.split("/").slice(0, 2).join("/"));
		}
	}
	return packages;
}

describe("bundled app dependency closure over pi's library entry", () => {
	it("declares every @earendil-works package pi statically imports but does not declare itself", () => {
		const reachable = reachableScopedPackages(join(piDist, "index.js"));
		// Sanity: the walk must actually reach pi's own internals, or a broken
		// traversal would make this test vacuously pass.
		expect(reachable.size).toBeGreaterThan(3);

		const appDeclares = appPackage.dependencies ?? {};
		const undeclared = [...reachable].filter((name) => !(name in piDeclares) && !(name in appDeclares)).sort();
		expect(undeclared, "add these to app/package.json dependencies at pi's exact version").toEqual([]);
	});

	it("pins any pi dependency it has to carry at pi's exact version", () => {
		const appDeclares = appPackage.dependencies ?? {};
		const piPin = appDeclares["@earendil-works/pi-coding-agent"];
		expect(piPin, "the app exact-pins pi").toBe(piPackage.version);
		for (const [name, range] of Object.entries(appDeclares)) {
			if (!name.startsWith(SCOPE)) continue;
			expect(range, `${name} must move in lockstep with pi's pin`).toBe(piPin);
		}
	});

	/**
	 * The two cases above cover the CURRENT gap generically, but neither ever
	 * asks us to clean up: once pi declares a package itself, the app's entry
	 * for it becomes dead weight that both tests happily keep accepting. This
	 * fails when that day comes — the same "pin the upstream assumption so a
	 * version bump surfaces the change" trick `app-bin-patches.test.ts` uses.
	 * `package.json` is strict JSON and cannot hold a reminder comment, so the
	 * reminder has to be executable.
	 */
	it("has no app-side entry for a package pi has since started declaring itself", () => {
		const appDeclares = appPackage.dependencies ?? {};
		const nowRedundant = Object.keys(appDeclares)
			.filter((name) => name !== "@earendil-works/pi-coding-agent" && name in piDeclares)
			.sort();
		expect(nowRedundant, "pi declares these now — drop them from app/package.json (and this repo's devDeps)").toEqual([]);
	});
});
