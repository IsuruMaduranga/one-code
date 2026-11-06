/**
 * No model-facing text left in the base (working-docs/features/profiles/,
 * Phase 3's exit). Every sentence-like literal in extensions/ (four or more
 * words, outside comments) sits in a file the allowlist names, with the
 * number it holds and why its sentences are not the model's: UI, logs,
 * errors only the user reads, formats, or the auto-mode classifier's prompt
 * (which moves with the ruleset in Phase 5). A new sentence fails until
 * someone decides where it belongs: the profile when the model reads it,
 * the allowlist (count and reason) when only a person does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_TEXT_ALLOWLIST } from "./base-text-allowlist.ts";
import { sentenceLiterals } from "./helpers/sentence-literals.ts";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");

const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
	});

const found = new Map(
	walk(ROOT)
		.map((path) => [relative(ROOT, path).split("\\").join("/"), sentenceLiterals(readFileSync(path, "utf8"), path)] as const)
		.filter(([, literals]) => literals.length > 0),
);

describe("the base's sentence-like literals", () => {
	it("are each in a reviewed file of the allowlist, as many as it says", () => {
		const problems: string[] = [];
		for (const [path, literals] of found) {
			const entry = BASE_TEXT_ALLOWLIST[path];
			if (!entry) {
				problems.push(`${path}: not in the allowlist. Move model-facing text to profile/, or add the file with a reason:\n    ${literals.join("\n    ")}`);
			} else if (literals.length > entry.count) {
				problems.push(`${path}: ${literals.length} sentences, the allowlist reviewed ${entry.count}. Decide where the new one belongs:\n    ${literals.join("\n    ")}`);
			} else if (literals.length < entry.count) {
				problems.push(`${path}: ${literals.length} sentences, the allowlist says ${entry.count}; lower it.`);
			}
		}
		for (const path of Object.keys(BASE_TEXT_ALLOWLIST)) {
			if (!found.has(path)) problems.push(`${path}: in the allowlist but has no sentences now; remove it.`);
		}
		expect(problems).toEqual([]);
	});

	it("each carry a reason", () => {
		const missing = Object.entries(BASE_TEXT_ALLOWLIST).filter(([, entry]) => entry.reason.trim().length < 10).map(([path]) => path);
		expect(missing).toEqual([]);
	});
});

describe("sentenceLiterals", () => {
	it("finds prose, not identifiers, paths or comments", () => {
		const source = [
			'// A comment with many words in it.',
			'const a = "Allow reads outside the working directories?";',
			'const b = "one-code:system-reminder";',
			'const c = `${x} costs more than this model`;',
			'import x from "./some/long path name here.ts";',
		].join("\n");
		expect(sentenceLiterals(source)).toEqual(["Allow reads outside the working directories?", "${…} costs more than this model"]);
	});
});
