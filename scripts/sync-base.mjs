#!/usr/bin/env node
/**
 * Brings a product's repository to one commit of the base harness. A product
 * is a copy of this repository with its own profile: everything outside the
 * product's own paths is the base's, byte for byte, and only this script
 * writes it.
 *
 * Run in the product's repository:
 *
 *   node scripts/sync-base.mjs <source> [ref]   copy the base at <ref>
 *   node scripts/sync-base.mjs --check [source] fail when the base differs
 *
 * <source> is a git repository, a local path or a URL; <ref> is a tag, a
 * branch or a commit (HEAD when left out). The first sync of a new product
 * runs from a checkout of the base:
 *
 *   node <base>/scripts/sync-base.mjs --into <product> <source> [ref]
 *
 * What a sync does:
 * - copies every file of the base at that commit, except the paths that are
 *   the product's (PRODUCT_PATHS, and the `own` list in `.base-sync.json`);
 * - deletes the files the base no longer has. A file outside the product's
 *   paths that git does not track in the product stops the sync instead,
 *   since nothing could bring it back;
 * - keeps the product's version in both package.json files, and stamps them
 *   from the product's brand (scripts/apply-brand.mjs);
 * - records the source and the commit in `.base-sync.json`.
 *
 * The sync runs the script of the commit it copies, so a change to these
 * rules arrives with the base that needs it. `--check` repeats the recorded
 * sync on a copy of the product and compares the two, so it holds whatever
 * a sync does, the stamping included.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SYNC_FILE = ".base-sync.json";
/** The paths of this repository that belong to the product built on it. A folder ends with a slash. */
export const PRODUCT_PATHS = ["profile/", "docs/", "demo/", ".github/", "README.md", "app/README.md", "install.ps1", "AGENTS.md", "CLAUDE.md", ".coderabbit.yaml", SYNC_FILE];
const STAMPED = ["package.json", "app/package.json"];
const FIRST_VERSION = "0.1.0";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
const lines = (text) => text.split("\0").filter(Boolean);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);

/** Whether `file` is the product's: under one of `paths` (a folder ends with a slash) or exactly one of them. */
export function isProductPath(file, paths) {
	return paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path));
}

/** The files a checkout of `dir` holds: tracked, or untracked and not ignored, and present. */
function checkoutFiles(dir) {
	if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a git repository: run git init there first`);
	return lines(git(dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard")).filter((file) => existsSync(join(dir, file)));
}

/** The base at `ref` of `source`, exported into a new folder: `{ dir, commit }`. */
export function fetchBase(source, ref) {
	const dir = mkdtempSync(join(tmpdir(), "base-sync-"));
	if (existsSync(source)) {
		const commit = git(source, "rev-parse", "--verify", `${ref}^{commit}`).trim();
		execFileSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", resolve(source), commit, dir]);
		return { dir, commit };
	}
	git(dir, "init", "-q");
	git(dir, "fetch", "-q", "--depth", "1", source, ref);
	git(dir, "checkout", "-q", "FETCH_HEAD");
	const commit = git(dir, "rev-parse", "HEAD").trim();
	rmSync(join(dir, ".git"), { recursive: true, force: true });
	return { dir, commit };
}

/** The paths a product owns: the fixed ones and those its sync record adds. */
const ownPaths = (record) => [...PRODUCT_PATHS, ...(record?.own ?? [])];

/** Every file under `dir`, as forward-slashed relative paths. */
function filesUnder(dir) {
	const found = [];
	for (const entry of execFileSync("find", [".", "-type", "f", "-print0"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0")) {
		if (entry) found.push(entry.replace(/^\.\//, ""));
	}
	return found.sort();
}

/**
 * Makes `product` hold the base in `base` (an exported tree): the copy, the
 * deletions, the versions, the stamp and the record. Returns what changed.
 */
export function applyBase(product, base, record) {
	const syncPath = join(product, SYNC_FILE);
	const previous = existsSync(syncPath) ? readJson(syncPath) : undefined;
	const own = ownPaths(previous);
	const version = previous && existsSync(join(product, "package.json")) ? readJson(join(product, "package.json")).version : FIRST_VERSION;

	const baseFiles = filesUnder(base).filter((file) => !isProductPath(file, own));
	const wanted = new Set(baseFiles);
	const stale = checkoutFiles(product).filter((file) => !isProductPath(file, own) && !wanted.has(file));
	const tracked = new Set(lines(git(product, "ls-files", "-z")));
	const lost = stale.filter((file) => !tracked.has(file));
	if (lost.length > 0) {
		throw new Error(`these files are not the base's and sit outside the product's paths:\n  ${lost.join("\n  ")}\nMove each under profile/, list it in "own" in ${SYNC_FILE}, or delete it.`);
	}
	for (const file of stale) rmSync(join(product, file));

	const written = [];
	for (const file of baseFiles) {
		const from = join(base, file);
		const to = join(product, file);
		const bytes = readFileSync(from);
		if (!existsSync(to) || !bytes.equals(readFileSync(to))) {
			mkdirSync(dirname(to), { recursive: true });
			writeFileSync(to, bytes);
			written.push(file);
		}
		chmodSync(to, statSync(from).mode & 0o777);
	}

	// The product's own version, in both packages and in the app's pin of the extension.
	const app = readJson(join(product, "app/package.json"));
	writeJson(join(product, "package.json"), { ...readJson(join(product, "package.json")), version });
	writeJson(join(product, "app/package.json"), { ...app, version, dependencies: { ...app.dependencies, [app.productExtension]: version } });
	const stamped = existsSync(join(product, "profile/brand.json"));
	if (stamped) execFileSync(process.execPath, ["scripts/apply-brand.mjs"], { cwd: product, stdio: "inherit" });

	writeJson(syncPath, { ...previous, ...record });
	return { written: written.filter((file) => !STAMPED.includes(file)), deleted: stale, stamped };
}

/** The base paths where `product` differs from a fresh sync of its recorded commit. */
export function checkBase(product, base) {
	const copy = mkdtempSync(join(tmpdir(), "base-check-"));
	try {
		const files = checkoutFiles(product);
		for (const file of files) cpSync(join(product, file), join(copy, file));
		git(copy, "init", "-q");
		git(copy, "add", "-A");
		const record = readJson(join(product, SYNC_FILE));
		const own = ownPaths(record);
		applyBase(copy, base, record);
		const expected = filesUnder(copy).filter((file) => !file.startsWith(".git/") && !isProductPath(file, own));
		const actual = new Set(files.filter((file) => !isProductPath(file, own)));
		const differing = expected.filter((file) => !actual.has(file) || !readFileSync(join(copy, file)).equals(readFileSync(join(product, file))));
		const expectedSet = new Set(expected);
		const extra = [...actual].filter((file) => !expectedSet.has(file));
		return [...differing.map((file) => `${file}: differs from the base`), ...extra.map((file) => `${file}: not in the base`)];
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
}

function main(argv) {
	const args = [...argv];
	const take = (flag) => {
		const at = args.indexOf(flag);
		if (at < 0) return undefined;
		return args.splice(at, 2)[1];
	};
	const product = resolve(take("--into") ?? process.cwd());
	const staged = take("--staged");
	const commitArg = take("--commit");
	const has = (flag) => {
		const at = args.indexOf(flag);
		if (at >= 0) args.splice(at, 1);
		return at >= 0;
	};
	const check = has("--check");
	const recorded = existsSync(join(product, SYNC_FILE)) ? readJson(join(product, SYNC_FILE)) : undefined;
	const source = args[0] ?? recorded?.source;
	if (!source) throw new Error("usage: node scripts/sync-base.mjs <source> [ref]   (or --check [source])");

	if (check) {
		if (!recorded?.commit) throw new Error(`${SYNC_FILE} records no commit: run a sync first`);
		const base = fetchBase(source, recorded.commit);
		try {
			const problems = checkBase(product, base.dir);
			if (problems.length === 0) return console.log(`the base matches ${recorded.ref} (${recorded.commit.slice(0, 8)})`);
			console.error(`the base differs from ${recorded.ref} (${recorded.commit.slice(0, 8)}):\n  ${problems.join("\n  ")}\nOnly scripts/sync-base.mjs writes the base; a change to it goes upstream.`);
			process.exitCode = 1;
		} finally {
			rmSync(base.dir, { recursive: true, force: true });
		}
		return;
	}

	const ref = args[1] ?? "HEAD";
	if (!staged) {
		// Hand over to the script of the commit being copied, so its rules apply.
		const base = fetchBase(source, ref);
		try {
			execFileSync(process.execPath, [join(base.dir, "scripts/sync-base.mjs"), "--into", product, "--staged", base.dir, "--commit", base.commit, source, ref], { stdio: "inherit" });
		} finally {
			rmSync(base.dir, { recursive: true, force: true });
		}
		return;
	}
	const result = applyBase(product, staged, { source, ref, commit: commitArg });
	console.log(`synced the base to ${ref} (${commitArg.slice(0, 8)}): ${result.written.length} files written, ${result.deleted.length} deleted${result.stamped ? "" : "; no profile/brand.json yet, so package.json is not stamped"}`);
}

// Compared as real paths: the copy this script hands over to sits in a temporary folder, which macOS reaches through a link.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`sync-base: ${error.message}`);
		process.exit(1);
	}
}
