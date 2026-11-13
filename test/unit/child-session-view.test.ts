/**
 * Every entry a child session loads reads the profile through its session's
 * view (lib/agents/child-extensions.ts `sessionView`). A child shares its
 * module copies with the main session, so `toolLive`, `requireText` and
 * `profileText` answer for the main session's tools there, and a child would
 * be told about tools it lacks.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS, LAST_CHILD_EXTENSION } from "../../extensions/lib/agents/child-extensions.ts";
import { EXTENSIONS_DIR } from "../../extensions/lib/core/package-root.ts";

describe("the entries a child session loads", () => {
	it("never read the main session's tools or text directly", () => {
		const offenders: string[] = [];
		for (const entry of [...CHILD_EXTENSIONS, LAST_CHILD_EXTENSION]) {
			// A `child.ts` wraps the tool its folder's index.ts defines.
			const files = new Set([entry, join(dirname(entry), "index.ts")]);
			for (const file of files) {
				const path = join(EXTENSIONS_DIR, file);
				if (!existsSync(path)) continue;
				const found = readFileSync(path, "utf8").match(/\b(toolLive|requireText|profileText)\(/g);
				if (found) offenders.push(`${file}: ${[...new Set(found)].join(" ")}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
