/**
 * What is wrong with a folder given to scripts/run-with-profile.sh as a
 * product's profile, or undefined when it can stand in for profile/: it
 * holds a `brand.json`, and the default profile's `index.ts`, which is the
 * folder's own or, when the brand names a `defaultProfile`, the one in
 * `profiles/<defaultProfile>/` (working-docs/decisions/bi-fork.md, "Each
 * product profile chooses its extensions").
 *
 * Run as a script, it prints the problem and exits 2.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileIdProblems } from "../../extensions/lib/profile/profile-ids.mjs";

export function profileFolderProblem(dir) {
	const brandFile = join(dir, "brand.json");
	if (!existsSync(brandFile)) return `${dir} holds no brand.json`;
	let brand;
	try {
		brand = JSON.parse(readFileSync(brandFile, "utf8"));
	} catch (error) {
		return `${brandFile} is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
	}
	if (typeof brand !== "object" || brand === null || Array.isArray(brand)) return `${brandFile} is not a JSON object`;
	// The harness's own rule (lib/profile/brand.mjs checkBrand), checked before the id becomes part of a path.
	const idProblems = profileIdProblems(brand);
	if (idProblems.length > 0) return `${brandFile}: ${idProblems.join("; ")}`;
	const id = brand.defaultProfile;
	const entry = id === undefined ? "index.ts" : join("profiles", id, "index.ts");
	if (!existsSync(join(dir, entry))) return id === undefined ? `${dir} holds no index.ts (and its brand.json names no defaultProfile)` : `${dir} holds no ${entry}, the default profile its brand.json names`;
	return undefined;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
	const problem = process.argv[2] === undefined ? "no profile folder given" : profileFolderProblem(process.argv[2]);
	if (problem !== undefined) {
		process.stderr.write(`${problem}\n`);
		process.exit(2);
	}
}
