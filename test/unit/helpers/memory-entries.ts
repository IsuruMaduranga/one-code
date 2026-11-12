/**
 * The /memory panel's rows over a temp folder, for memory-entries and its One
 * Code sibling: the folder is the home, and holds the product's state folder
 * and the auto-memory folder.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brand } from "../../../extensions/lib/profile/brand.mjs";
import { buildMemoryEntries } from "../../../extensions/context/memory/entries.ts";

/** Writes `content` to `<root>/<rel>` and returns the absolute path. */
export function writeUnder(root: string, rel: string, content = "x"): string {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

/** The panel's rows for a session in `cwd`, with `root` as the home. */
export function memoryEntriesIn(root: string, cwd: string) {
	return buildMemoryEntries({
		agentDir: undefined,
		cwd,
		home: root,
		homeOneCodeDir: join(root, brand.stateDir),
		memoryDir: join(root, "mem"),
	});
}
