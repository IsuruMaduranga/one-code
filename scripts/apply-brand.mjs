#!/usr/bin/env node
/**
 * Stamp the two package.json files from the profile's brand
 * (working-docs/decisions/bi-fork.md, "The brand is one static data file"), so
 * a product's copy differs from One Code's release only in profile/:
 *
 * - package.json: `name` is the extension package;
 * - app/package.json: `name` is the app package, `bin` the command, and
 *   `productExtension` plus the dependency key name the extension package
 *   (app/bin.mjs finds it through that field). The dependency keeps its version.
 *
 * `node scripts/apply-brand.mjs` writes the files; `--check` writes nothing and
 * exits 1 when either differs from the brand (test/unit/apply-brand.test.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../extensions/lib/brand.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The root package with the brand's extension name. */
export function stampExtension(pkg) {
	return { ...pkg, name: brand.packages.extension };
}

/** The app package with the brand's names; the extension dependency is renamed in place, keeping its version and position. */
export function stampApp(pkg) {
	const previous = pkg.productExtension;
	const dependencies = {};
	for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
		dependencies[name === previous ? brand.packages.extension : name] = version;
	}
	if (!(brand.packages.extension in dependencies)) throw new Error(`app/package.json: no dependency named by productExtension ("${previous}") to rename to ${brand.packages.extension}`);
	const out = {};
	for (const [key, value] of Object.entries(pkg)) {
		if (key === "productExtension") continue;
		out[key] = key === "name" ? brand.packages.app : key === "dependencies" ? dependencies : value;
		if (key === "bin") {
			out.bin = { [brand.bin]: "bin.mjs" };
			out.productExtension = brand.packages.extension;
		}
	}
	return out;
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
