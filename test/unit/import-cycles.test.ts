/**
 * No module in extensions/ or profile/ imports itself back through a chain of
 * static value imports. A module caught in a cycle can be handed out half
 * loaded (an export still undefined at another module's load time), which
 * surfaced as an order-dependent unit-test failure (`compareVersions is not
 * a function`) while `lib/notifications.ts` sat in one. Type-only imports are
 * erased and `import()`/`require()` load on call, so neither counts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { valueImports } from "./helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (/\.(ts|mts|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

/** The strongly connected groups of more than one module (Tarjan), as repo-relative paths. */
function cycles(files: string[]): string[][] {
	const graph = new Map<string, string[]>();
	for (const file of files) {
		const deps = valueImports(readFileSync(file, "utf8"), file)
			.filter((found) => !found.dynamic && found.specifier.startsWith("."))
			.map((found) => resolve(dirname(file), found.specifier))
			.filter((path) => existsSync(path));
		graph.set(file, deps);
	}
	let next = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const groups: string[][] = [];
	const visit = (node: string) => {
		index.set(node, next);
		low.set(node, next);
		next++;
		stack.push(node);
		onStack.add(node);
		for (const dep of graph.get(node) ?? []) {
			if (!graph.has(dep)) continue;
			if (!index.has(dep)) {
				visit(dep);
				low.set(node, Math.min(low.get(node)!, low.get(dep)!));
			} else if (onStack.has(dep)) low.set(node, Math.min(low.get(node)!, index.get(dep)!));
		}
		if (low.get(node) === index.get(node)) {
			const group: string[] = [];
			let member: string;
			do {
				member = stack.pop()!;
				onStack.delete(member);
				group.push(relative(ROOT, member).split("\\").join("/"));
			} while (member !== node);
			if (group.length > 1) groups.push(group.sort());
		}
	};
	for (const node of graph.keys()) if (!index.has(node)) visit(node);
	return groups;
}

describe("the import graph", () => {
	it("finds a cycle when there is one", () => {
		const dir = join(import.meta.dirname, "fixtures", "import-cycle");
		expect(cycles(sources(dir))).toHaveLength(1);
	});

	it("has no static value-import cycle in extensions/ or profile/", () => {
		expect(cycles([...sources(join(ROOT, "extensions")), ...sources(join(ROOT, "profile"))])).toEqual([]);
	});
});
