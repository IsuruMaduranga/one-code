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
 * pi 0.85.0 shipped one that was not: `dist/index.js` re-exported `main` from
 * `main.js`, which imported `experimental/server.js`, which imported
 * `@earendil-works/pi-server` — a package published on npm but absent from
 * pi's own `dependencies` and `npm-shrinkwrap.json`. pi's CLI never noticed
 * (its bundle inlines that code), and neither did `tsc` (types resolve without
 * evaluating the graph), so a clean `npm i -g @one-ai/one-code` crashed on
 * launch. The app declared `pi-server` to cover it (findings §6). pi 0.85.1
 * fixed it (#9132): the experimental code is source-only, `dist/experimental/`
 * is gone, nothing imports `pi-server`, and pi now declares its own shared
 * internals (pi-agent-core, pi-ai, pi-tui) — so the app no longer carries
 * `pi-server` and needs no `overrides`. This test stays as the guard for the
 * next time pi forgets to declare something its library entry imports.
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
	version: string;
	dependencies?: Record<string, string>;
};
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
	version: string;
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
		// traversal would make this test vacuously pass. 0.85.1's slimmer library
		// entry (experimental code removed, #9132) reaches three (pi-agent-core,
		// pi-ai, pi-tui); a real traversal never returns fewer.
		expect(reachable.size).toBeGreaterThanOrEqual(3);

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
	/**
	 * Releases are lockstep (working-docs/decisions/distribution.md): both packages ship
	 * the same version every release, and the app pins `one-code-extension` at
	 * exactly its own version. The exact pin means the extension must publish
	 * FIRST — publishing the app first gives every installer "No matching version
	 * found for one-code-extension@<v>". Distribution review 2026-09-09, M2: the
	 * tag v0.2.0 named a tree that was never published while three weeks of
	 * commits carried the same version, and nothing guarded the three-way match.
	 */
	it("keeps root version, app version, and the app's extension pin in lockstep", () => {
		const appDeclares = appPackage.dependencies ?? {};
		expect(appPackage.version, "app version matches root version").toBe(rootPackage.version);
		expect(appDeclares["one-code-extension"], "the app pins one-code-extension at its own version").toBe(rootPackage.version);
	});

	it("has no app-side entry for a package pi has since started declaring itself", () => {
		const appDeclares = appPackage.dependencies ?? {};
		const nowRedundant = Object.keys(appDeclares)
			.filter((name) => name !== "@earendil-works/pi-coding-agent" && name in piDeclares)
			.sort();
		expect(nowRedundant, "pi declares these now — drop them from app/package.json (and this repo's devDeps)").toEqual([]);
	});
});
