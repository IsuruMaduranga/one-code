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
 *
 * A product may ship several profiles (working-docs/decisions/bi-fork.md,
 * "Profiles are chosen at launch"): `profile/` is the default one, and each
 * id in the brand's `profiles` list names a folder `profile/profiles/<id>/`
 * with its own `index.ts` and a `brand.json` holding only the names that
 * differ (`PROFILE_BRAND_FIELDS`). The launch chooses one: `--profile <name>`,
 * `--<id>` or `<envPrefix>_PROFILE`. A name that is no product profile is a
 * user's own profile (lib/profile/user-profile.ts), which may name the
 * product profile it sits on. The choice is read here, before any module
 * reads a name, because the state folder's name is one of them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
	if (value.spinnerVerbs !== undefined && (!Array.isArray(value.spinnerVerbs) || value.spinnerVerbs.some((verb) => typeof verb !== "string" || verb.trim() === ""))) problems.push(`"spinnerVerbs" must be an array of words`);
	// A folder inside the package, forward-slashed: it is joined to the package root and listed in package.json `files`.
	if (value.guideDir !== undefined && (typeof value.guideDir !== "string" || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value.guideDir) || value.guideDir.split("/").some((part) => part === "." || part === "..") || `${value.guideDir}/`.startsWith("profile/test/"))) problems.push(`"guideDir" must be a folder path inside the package ("docs/guide"), outside profile/test, when set`);
	if (typeof value.envPrefix === "string" && !/^[A-Z][A-Z0-9_]*$/.test(value.envPrefix)) problems.push(`"envPrefix" must be upper-case letters, digits and underscores`);
	if (typeof value.idPrefix === "string" && !/^[a-z][a-z0-9-]*$/.test(value.idPrefix)) problems.push(`"idPrefix" must be lower-case letters, digits and hyphens`);
	// Path checks compare case-folded paths on macOS and Windows (lib/profile/paths.ts comparablePath) against patterns built from this name.
	// The leading dot is required: the name is a protected path segment at any depth (lib/rules/protected-paths.ts), and a plain word such as "agent" would guard every folder of that name.
	if (typeof value.stateDir === "string" && !STATE_DIR_NAME.test(value.stateDir)) problems.push(`"stateDir" must be one lower-case folder name starting with "." (letters, digits, ".", "_", "-")`);
	if (value.profiles !== undefined) {
		if (!Array.isArray(value.profiles) || value.profiles.some((id) => typeof id !== "string" || !PROFILE_NAME.test(id))) problems.push(`"profiles" must be an array of profile ids (letters, digits, ".", "_", "-")`);
		else if (new Set(value.profiles.map((id) => id.toLowerCase())).size !== value.profiles.length) problems.push(`"profiles" names an id twice (ids compare without case)`);
		else if (value.profiles.some((id) => id.toLowerCase() === "profile")) problems.push(`"profiles" must not use the id "profile": \`--profile\` takes a name`);
	}
	if (problems.length > 0) throw new Error(`profile/brand.json: ${problems.join("; ")}`);
	return value;
}

const STATE_DIR_NAME = /^\.[a-z0-9][a-z0-9._-]*$/;
/** A profile's name, a product's or a user's: it is a folder name and a launch flag. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The names a product profile's own `brand.json` may set; every other name is the product's. */
export const PROFILE_BRAND_FIELDS = ["name", "stateDir", "productFile", "theme", "subtitle", "wordmark", "spinnerVerbs"];

/**
 * The launch's choice of profile in `args` (the arguments after the command),
 * and the arguments without it: `--profile <name>`, `--profile=<name>`, or
 * `--<id>` for a product profile's id in any case (`--BI`). The first one
 * names the profile; arguments after a bare `--` are not read.
 */
function splitProfileFlags(args, product) {
	const ids = new Set((product.profiles ?? []).map((id) => id.toLowerCase()));
	const rest = [];
	let name;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			rest.push(...args.slice(i));
			break;
		}
		let found;
		if (arg === "--profile") found = args[++i] ?? "";
		else if (arg.startsWith("--profile=")) found = arg.slice("--profile=".length);
		else if (arg.startsWith("--") && ids.has(arg.slice(2).toLowerCase())) found = arg.slice(2);
		if (found === undefined) rest.push(arg);
		else name ??= found || undefined;
	}
	return { name, rest };
}

/** The profile the launch names, or undefined: `<envPrefix>_PROFILE`, else the command line's choice (`splitProfileFlags`). */
export function selectedProfileName(product, argv = process.argv, env = process.env) {
	return env[`${product.envPrefix}_PROFILE`] || splitProfileFlags(argv.slice(2), product).name;
}

/**
 * `args` (the arguments after the command) without the launch's choice of
 * profile, for the bundled app, which reads the choice itself: pi would take
 * the word after `--BI` as that flag's value and lose a prompt given there.
 */
export function withoutProfileFlags(args, product) {
	return splitProfileFlags(args, product).rest;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The brand in force for a launch: the product's `data`, with the chosen
 * product profile's names over it. `name` is what the launch asked for
 * (`selectedProfileName`); `read` reads a JSON file (a test passes its own).
 * A name that is no product profile is a user's: its `profile.json` in
 * `<shared state dir>/profiles/<name>/` may name the product profile it sits
 * on (`base`). A user profile that is missing or unreadable resolves to the
 * default product profile here; lib/profile/user-profile.ts reports it.
 */
export function resolveBrand(data, options) {
	return resolveChecked(checkBrand(structuredClone(data)), options);
}

/** `resolveBrand` for a brand already checked and copied. */
function resolveChecked(product, { name, profileRoot, sharedStateDir, read = readJson }) {
	const byId = new Map((product.profiles ?? []).map((id) => [id.toLowerCase(), id]));
	let productProfile = name === undefined ? undefined : byId.get(name.toLowerCase());
	let userProfile;
	if (name !== undefined && productProfile === undefined) {
		userProfile = name;
		if (PROFILE_NAME.test(name)) {
			try {
				const base = read(join(sharedStateDir, "profiles", name, "profile.json")).base;
				if (typeof base === "string") productProfile = byId.get(base.toLowerCase());
			} catch {}
		}
	}
	const merged = { ...product };
	if (productProfile !== undefined) {
		const file = join(profileRoot, "profiles", productProfile, "brand.json");
		let own;
		try {
			own = read(file);
		} catch (error) {
			throw new Error(`profile "${productProfile}": cannot read ${file} (${error instanceof Error ? error.message : error})`);
		}
		if (typeof own !== "object" || own === null || Array.isArray(own)) throw new Error(`${file}: not a JSON object`);
		const unknown = Object.keys(own).filter((key) => !PROFILE_BRAND_FIELDS.includes(key));
		if (unknown.length > 0) throw new Error(`${file}: a profile's brand may set only ${PROFILE_BRAND_FIELDS.join(", ")} (found ${unknown.join(", ")})`);
		Object.assign(merged, own);
		checkBrand(merged);
	}
	return {
		brand: merged,
		/** The product's own names, whichever profile runs: the folder the profiles share (sign-in, sessions, users' profiles) is named by its `stateDir`. */
		product,
		selection: { ...(productProfile !== undefined ? { productProfile } : {}), ...(userProfile !== undefined ? { userProfile } : {}) },
		/** The profile's folder, relative to the package root, forward-slashed. */
		profileDir: productProfile === undefined ? "profile" : `profile/profiles/${productProfile}`,
	};
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
const PROFILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "profile");

/** The state folder a brand names: `<envPrefix>_STATE_DIR`, else `~/<its stateDir>`. */
function stateDirOf(named, env, home) {
	return env[`${named.envPrefix}_STATE_DIR`] || join(home, named.stateDir);
}

const checked = checkBrand(structuredClone(data));
const resolved = resolveChecked(checked, {
	name: selectedProfileName(checked),
	profileRoot: PROFILE_ROOT,
	sharedStateDir: stateDirOf(checked, process.env, homedir()),
});

export const brand = deepFreeze(resolved.brand);

/** The product's own brand, before the chosen profile's names: equal to `brand` on the default profile. */
export const productBrand = deepFreeze(resolved.product);

/** The launch's choice: a product profile's id, a user's profile's name, both (a user profile on a product profile) or neither. */
export const profileSelection = Object.freeze(resolved.selection);

/** The chosen profile's folder, relative to the package root: `profile`, or `profile/profiles/<id>`. */
export const profileDirName = resolved.profileDir;

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

/** The product's state directory: `<envPrefix>_STATE_DIR`, else `~/<stateDir>` (the chosen profile's name for it). */
export function productStateDir(env = process.env, home = homedir()) {
	return stateDirOf(brand, env, home);
}

/**
 * The folder every profile of the product shares, whichever one runs: the
 * app's pi agent directory (sign-in, model list) and the users' own
 * profiles. `productStateDir` on the default profile.
 */
export function sharedStateDir(env = process.env, home = homedir()) {
	return stateDirOf(productBrand, env, home);
}

/** Where a user's own profiles live: one folder each, by name. */
export function userProfilesDir(env = process.env, home = homedir()) {
	return join(sharedStateDir(env, home), "profiles");
}
