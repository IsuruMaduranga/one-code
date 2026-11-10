#!/usr/bin/env node
/**
 * Stamp the two package.json files from the profile's brand
 * (working-docs/decisions/bi-fork.md, "The brand is one static data file"), so
 * a product's copy differs from One Code's release only in profile/:
 *
 * - package.json: `name` is the extension package, and `files` ends with the
 *   product's guide folder (the brand's `guideDir`) when it sits outside
 *   profile/, so one product's guide never ships in another;
 * - app/package.json: `name` is the app package, `bin` the command, and
 *   `productExtension` plus the dependency key name the extension package
 *   (app/bin.mjs finds it through that field). The dependency keeps its version;
 * - both: `description` and `keywords` from the brand's `packageInfo`, and
 *   `repository`, `homepage` and `bugs` from its `homepage` (the repository's
 *   web URL). A repository `directory` is kept.
 *
 * `node scripts/apply-brand.mjs` writes the files; `--check` writes nothing and
 * exits 1 when either differs from the brand (test/unit/apply-brand.test.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand, guideDir } from "../extensions/lib/profile/brand.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The npm listing fields of the package `which` ("app" or "extension"). */
function listing(pkg, which) {
	const { description, keywords } = brand.packageInfo[which];
	return {
		description,
		keywords: [...keywords],
		repository: { ...pkg.repository, type: "git", url: `git+${brand.homepage}.git` },
		homepage: `${brand.homepage}#readme`,
		bugs: { url: `${brand.homepage}/issues` },
	};
}

/** What the extension package ships besides the product's guide. */
const EXTENSION_FILES = ["extensions/", "profile/", "!profile/test/", "types/", "README.md", "LICENSE"];

/** The extension's `files`: the fixed list, then the guide when it sits outside profile/ (which ships whole). */
function extensionFiles() {
	return guideDir.startsWith("profile/") ? EXTENSION_FILES : [...EXTENSION_FILES, `${guideDir}/`];
}

/** The root package with the brand's extension name and listing, and the files it ships (when it lists them). */
export function stampExtension(pkg) {
	return { ...pkg, name: brand.packages.extension, ...(pkg.files ? { files: extensionFiles() } : {}), ...listing(pkg, "extension") };
}

/**
 * The app package with the brand's names. Overriding a key in a spread keeps
 * its position, so the stamp moves nothing; the extension dependency is renamed
 * in place, keeping its version and position.
 */
export function stampApp(pkg) {
	const previous = pkg.productExtension;
	const dependencies = {};
	for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
		dependencies[name === previous ? brand.packages.extension : name] = version;
	}
	if (!(brand.packages.extension in dependencies)) throw new Error(`app/package.json: no dependency named by productExtension ("${previous}") to rename to ${brand.packages.extension}`);
	return {
		...pkg,
		name: brand.packages.app,
		bin: { [brand.bin]: "bin.mjs" },
		productExtension: brand.packages.extension,
		dependencies,
		...listing(pkg, "app"),
	};
}

const format = (pkg) => `${JSON.stringify(pkg, null, "\t")}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes("--check");
	let stale = false;
	for (const [file, stamp] of [
		["package.json", stampExtension],
		["app/package.json", stampApp],
	]) {
		const path = join(root, file);
		const before = readFileSync(path, "utf8");
		const after = format(stamp(JSON.parse(before)));
		if (before === after) continue;
		stale = true;
		if (check) process.stderr.write(`${file} does not match profile/brand.json; run node scripts/apply-brand.mjs\n`);
		else writeFileSync(path, after);
	}
	if (check && stale) process.exit(1);
}
