/**
 * Distribution review 2026-09-09, H1: extension code must import
 * `@earendil-works/pi-ai` only as the bare specifier or one of the subpaths pi's
 * extension loader aliases exactly (`/compat`, `/oauth`, `/providers/all`).
 * Every other subpath (`/api/*`, `/utils/*`, …) is rewritten by jiti's prefix
 * alias onto pi-ai's compat entry under the bundled app's library loader,
 * producing a dead path — so the app cannot load the extension set, while the
 * pi CLI and unit tests resolve the subpath from node_modules and never notice.
 *
 * This walks every extension source file and fails on a disallowed pi-ai import.
 * Test files under test/ are exempt: vitest resolves node_modules directly, and
 * the parity test in pi-ai-estimate.test.ts must import the real deep paths.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionsDir = fileURLToPath(new URL("../../extensions", import.meta.url));

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Matches any pi-ai import EXCEPT the bare specifier or the exactly-aliased subpaths. */
const disallowed = /from\s+["']@earendil-works\/pi-ai\/(?!compat["']|oauth["']|providers\/all["'])[^"']+["']/g;

describe("pi-ai import shape (distribution H1)", () => {
	it("no extension imports a pi-ai subpath the app's loader cannot resolve", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(extensionsDir)) {
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(disallowed)) {
				offenders.push(`${file.slice(extensionsDir.length + 1)}: ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
