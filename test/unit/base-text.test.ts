/**
 * No model-facing text left in the base (working-docs/features/profiles/,
 * Phase 3's exit). Every sentence-like literal in extensions/ (four or more
 * words, outside comments) sits in a file the allowlist names with why its
 * sentences are not the model's (UI, logs, errors only the user reads,
 * formats), and matches the reviewed list in
 * base-text-literals.txt. A new or changed sentence fails until someone
 * decides where it belongs: the profile when the model reads it, the list
 * (`vitest -u`, reviewed in the diff) when only a person does.
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
	it("are each in a file of the allowlist", () => {
		const problems: string[] = [];
		for (const [path, literals] of found) {
			if (!BASE_TEXT_ALLOWLIST[path]) {
				problems.push(`${path}: not in the allowlist. Move model-facing text to profile/, or add the file with a reason:\n    ${literals.join("\n    ")}`);
			}
		}
		for (const path of Object.keys(BASE_TEXT_ALLOWLIST)) {
			if (!found.has(path)) problems.push(`${path}: in the allowlist but has no sentences now; remove it.`);
		}
		expect(problems).toEqual([]);
	});

	it("are the reviewed ones", async () => {
		const listing = [...found]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, literals]) => `${path}\n${literals.map((literal) => `\t${JSON.stringify(literal)}`).join("\n")}\n`)
			.join("\n");
		await expect(listing).toMatchFileSnapshot("./base-text-literals.txt");
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
