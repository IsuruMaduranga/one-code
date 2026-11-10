/**
 * The product's names, from the profile's `brand.json`
 * (working-docs/decisions/bi-fork.md, "The brand is one static data file").
 *
 * Plain JS with only node builtins and a JSON import, so the bundled app's
 * launcher reads it in plain Node before pi's TypeScript loader exists (Node
 * refuses to strip types under node_modules), and every extension reads the
 * same module through jiti. Types: types/app.d.ts; `brand.test.ts` checks that
 * `profile/brand.json` satisfies `Brand`.
 *
 * Everything here is fixed for the process: ids and environment names are
 * module-scope constants in their owners, so the prefix is known at import.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import data from "../../../profile/brand.json" with { type: "json" };

const REQUIRED = ["name", "idPrefix", "bin", "envPrefix", "stateDir", "productFile", "theme", "homepage", "subtitle"];

/** Throws on a brand missing a name, so a broken profile stops the process instead of naming things "undefined". */
export function checkBrand(value) {
	const problems = [];
	if (typeof value !== "object" || value === null) throw new Error("profile/brand.json: not a JSON object");
	for (const key of REQUIRED) {
		if (typeof value[key] !== "string" || value[key] === "") problems.push(`"${key}" must be a non-empty string`);
	}
	if (!Array.isArray(value.wordmark) || value.wordmark.some((row) => typeof row !== "string")) problems.push(`"wordmark" must be an array of strings`);
	const packages = value.packages;
	if (typeof packages !== "object" || packages === null) problems.push(`"packages" must be an object`);
	else {
		for (const key of ["app", "extension"]) {
			if (typeof packages[key] !== "string" || packages[key] === "") problems.push(`"packages.${key}" must be a non-empty string`);
		}
		if (packages.homebrewFormula !== undefined && typeof packages.homebrewFormula !== "string") problems.push(`"packages.homebrewFormula" must be a string when set`);
	}
	for (const key of ["app", "extension"]) {
		const info = value.packageInfo?.[key];
		if (typeof info?.description !== "string" || info.description === "") problems.push(`"packageInfo.${key}.description" must be a non-empty string`);
		if (!Array.isArray(info?.keywords) || info.keywords.some((word) => typeof word !== "string")) problems.push(`"packageInfo.${key}.keywords" must be an array of strings`);
	}
	// A folder inside the package, forward-slashed: it is joined to the package root and listed in package.json `files`.
	if (value.guideDir !== undefined && (typeof value.guideDir !== "string" || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value.guideDir) || value.guideDir.split("/").includes(".."))) problems.push(`"guideDir" must be a folder path inside the package ("docs/guide") when set`);
	if (typeof value.envPrefix === "string" && !/^[A-Z][A-Z0-9_]*$/.test(value.envPrefix)) problems.push(`"envPrefix" must be upper-case letters, digits and underscores`);
	if (typeof value.idPrefix === "string" && !/^[a-z][a-z0-9-]*$/.test(value.idPrefix)) problems.push(`"idPrefix" must be lower-case letters, digits and hyphens`);
	// Path checks compare case-folded paths on macOS and Windows (lib/profile/paths.ts comparablePath) against patterns built from this name.
	// The leading dot is required: the name is a protected path segment at any depth (lib/rules/protected-paths.ts), and a plain word such as "agent" would guard every folder of that name.
	if (typeof value.stateDir === "string" && !/^\.[a-z0-9][a-z0-9._-]*$/.test(value.stateDir)) problems.push(`"stateDir" must be one lower-case folder name starting with "." (letters, digits, ".", "_", "-")`);
	if (problems.length > 0) throw new Error(`profile/brand.json: ${problems.join("; ")}`);
	return value;
}

/** `value` and everything under it, frozen in place. */
function deepFreeze(value) {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/**
 * The shipped product's brand: a frozen copy, never the JSON module's own
 * object, which a loader may still extend (jiti adds `default` to it on a later
 * import).
 */
export const brand = deepFreeze(checkBrand(structuredClone(data)));

/**
 * The product's user guide, relative to the package root: the brand's
 * `guideDir`, else `profile/guide` (a product keeps its guide in its profile;
 * One Code's is its public `docs/guide`).
 */
export const guideDir = brand.guideDir ?? "profile/guide";

/** An internal event-channel or session-entry id: `<idPrefix>:<name>`. Changing the prefix orphans state in old sessions. */
export function brandedId(name) {
	return `${brand.idPrefix}:${name}`;
}

/** The product's spelling of an environment variable: `<envPrefix>_<suffix>`. */
export function envName(suffix) {
	return `${brand.envPrefix}_${suffix}`;
}

/**
 * The state directory's name as a regular-expression fragment that matches it
 * literally (`\\.onecode`), for the safety floor's path-tail patterns.
 */
export const stateDirPattern = brand.stateDir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The product's state directory: `<envPrefix>_STATE_DIR`, else `~/<stateDir>`. */
export function productStateDir(env = process.env, home = homedir()) {
	return env[envName("STATE_DIR")] || join(home, brand.stateDir);
}
