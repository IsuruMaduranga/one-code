/**
 * A variable Claude Code also spells (the provider's `envAliases`) is read
 * through a knob (lib/profile/knobs.ts `readKnob`), which tries both
 * spellings. A direct `env[envName("X")]` read of such a name would ignore
 * the user's Claude Code spelling without a word.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sources } from "../claude-code/sources.ts";
import { sourceFiles } from "../../test/unit/helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");

describe("a variable with a Claude Code spelling", () => {
	it("is never read by its product spelling alone", () => {
		const aliased = new Set(Object.keys(sources.open({ home: homedir() }).envAliases ?? {}));
		expect(aliased.size).toBeGreaterThan(3);
		const offenders: string[] = [];
		for (const entry of sourceFiles(ROOT, ROOT)) {
			for (const [, literal, constant] of readFileSync(join(ROOT, entry), "utf8").matchAll(/\benv\s*\[\s*envName\(\s*(?:"(\w+)"|(\w+))\s*\)\s*\]/g)) {
				// A constant hides the name from this check: a direct read names its variable.
				if (constant !== undefined || aliased.has(literal)) offenders.push(`${entry}: ${literal ?? constant}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
