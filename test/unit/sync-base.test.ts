/**
 * scripts/sync-base.mjs: a product's repository holds the base byte for byte
 * outside its own paths, and only a sync writes it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBase, checkBase, fetchBase, isProductPath, PRODUCT_PATHS, SYNC_FILE, syncTarget } from "../../scripts/sync-base.mjs";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function write(dir: string, files: Record<string, string>) {
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
}

function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "sync-base-test-"));
	made.push(dir);
	git(dir, "init", "-q");
	write(dir, files);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "one", "--allow-empty");
	return dir;
}

const pkg = (name: string, version: string) => JSON.stringify({ name, version });
const appPkg = (version: string) => JSON.stringify({ name: "app", version, productExtension: "ext", dependencies: { pi: "1.0.0", ext: version } });
const baseFiles = { "package.json": pkg("ext", "3.0.0"), "app/package.json": appPkg("3.0.0"), "extensions/a.ts": "a1", "extensions/gone.ts": "gone", "profile/index.ts": "base product", "README.md": "base readme" };

/** A base repository, and a product synced to its first commit. */
function synced() {
	const base = repo(baseFiles);
	const product = repo({ "profile/index.ts": "mine", "README.md": "my readme" });
	const first = fetchBase(base, "HEAD");
	made.push(first.dir);
	applyBase(product, first.dir, { source: base, ref: "HEAD", commit: first.commit });
	return { base, product, first };
}

describe("sync-base", () => {
	it("knows a product path by folder prefix or exact name", () => {
		expect(isProductPath("profile/text/a.ts", PRODUCT_PATHS)).toBe(true);
		expect(isProductPath("README.md", PRODUCT_PATHS)).toBe(true);
		expect(isProductPath("extensions/README.md", PRODUCT_PATHS)).toBe(false);
		expect(isProductPath("profiles.ts", PRODUCT_PATHS)).toBe(false);
	});

	it("copies the base, leaves the product's paths alone, and gives the product its own version", () => {
		const { product, first } = synced();
		expect(readFileSync(join(product, "extensions/a.ts"), "utf8")).toBe("a1");
		expect(readFileSync(join(product, "profile/index.ts"), "utf8")).toBe("mine");
		expect(readFileSync(join(product, "README.md"), "utf8")).toBe("my readme");
		expect(JSON.parse(readFileSync(join(product, "package.json"), "utf8")).version).toBe("0.1.0");
		expect(JSON.parse(readFileSync(join(product, "app/package.json"), "utf8")).dependencies).toEqual({ pi: "1.0.0", ext: "0.1.0" });
		expect(JSON.parse(readFileSync(join(product, SYNC_FILE), "utf8")).commit).toBe(first.commit);
		expect(checkBase(product, first.dir)).toEqual([]);
	});

	it("follows the base to a newer commit: a changed file, a deleted one, and the product's version kept", () => {
		const { base, product } = synced();
		git(product, "add", "-A");
		git(product, "commit", "-q", "-m", "synced");
		writeFileSync(join(product, "package.json"), pkg("ext", "0.4.0"));
		write(base, { "extensions/a.ts": "a2", "extensions/new.ts": "new" });
		rmSync(join(base, "extensions/gone.ts"));
		git(base, "add", "-A");
		git(base, "commit", "-q", "-m", "two");
		const next = fetchBase(base, "HEAD");
		made.push(next.dir);
		const result = applyBase(product, next.dir, { source: base, ref: "HEAD", commit: next.commit });
		expect(result.written.sort()).toEqual(["extensions/a.ts", "extensions/new.ts"]);
		expect(result.deleted).toEqual(["extensions/gone.ts"]);
		expect(existsSync(join(product, "extensions/gone.ts"))).toBe(false);
		expect(JSON.parse(readFileSync(join(product, "package.json"), "utf8")).version).toBe("0.4.0");
		expect(checkBase(product, next.dir)).toEqual([]);
	});

	it("reports a base file edited in the product, and one added outside the product's paths", () => {
		const { product, first } = synced();
		writeFileSync(join(product, "extensions/a.ts"), "edited");
		write(product, { "extensions/mine.ts": "x" });
		expect(checkBase(product, first.dir).sort()).toEqual(["extensions/a.ts: differs from the base", "extensions/mine.ts: not in the base"]);
	});

	it("stops instead of deleting a file git could not bring back, unless the product lists it as its own", () => {
		const { product, first } = synced();
		write(product, { "notes/todo.md": "x" });
		expect(() => applyBase(product, first.dir, { commit: first.commit })).toThrow(/notes\/todo\.md[\s\S]*"own"/);
		const record = JSON.parse(readFileSync(join(product, SYNC_FILE), "utf8"));
		writeFileSync(join(product, SYNC_FILE), JSON.stringify({ ...record, own: ["notes/"] }));
		applyBase(product, first.dir, { commit: first.commit });
		expect(existsSync(join(product, "notes/todo.md"))).toBe(true);
		expect(JSON.parse(readFileSync(join(product, SYNC_FILE), "utf8")).own).toEqual(["notes/"]);
		expect(checkBase(product, first.dir)).toEqual([]);
	});

	it("gives the lockfile the stamped package's name and version, so an install changes no base file", () => {
		const base = repo({ ...baseFiles, "package-lock.json": JSON.stringify({ name: "ext", version: "3.0.0", lockfileVersion: 3, packages: { "": { name: "ext", version: "3.0.0" }, "node_modules/x": { version: "1.0.0" } } }) });
		const product = repo({ "profile/index.ts": "mine" });
		const first = fetchBase(base, "HEAD");
		made.push(first.dir);
		applyBase(product, first.dir, { source: base, ref: "HEAD", commit: first.commit });
		const lock = JSON.parse(readFileSync(join(product, "package-lock.json"), "utf8"));
		expect(lock).toMatchObject({ name: "ext", version: "0.1.0", packages: { "": { name: "ext", version: "0.1.0" }, "node_modules/x": { version: "1.0.0" } } });
		expect(checkBase(product, first.dir)).toEqual([]);
	});

	it("checks a file the product tracks although .gitignore matches it", () => {
		const { product, first } = synced();
		write(product, { ".gitignore": "*.log\n", "extensions/debug.log": "x" });
		git(product, "add", "-A");
		git(product, "add", "-f", "extensions/debug.log");
		expect(checkBase(product, first.dir)).toContain("extensions/debug.log: not in the base");
	});

	it("fails on a ref the base does not have and leaves no folder behind", () => {
		const base = repo(baseFiles);
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("base-sync-")).length;
		expect(() => fetchBase(base, "no-such-ref")).toThrow();
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith("base-sync-")).length).toBe(before);
	});

	it("reuses the recorded source and ref when given no arguments, and records a local source absolute", () => {
		const base = repo(baseFiles);
		expect(syncTarget([], { source: base, ref: "dev" })).toEqual({ source: base, ref: "dev" });
		expect(syncTarget([base], { source: base, ref: "dev" })).toEqual({ source: base, ref: "HEAD" });
		expect(syncTarget([base, "v1"], undefined)).toEqual({ source: base, ref: "v1" });
		expect(syncTarget(["https://example.com/base.git"], undefined)).toEqual({ source: "https://example.com/base.git", ref: "HEAD" });
		const cwd = process.cwd();
		try {
			process.chdir(dirname(base));
			expect(realpathSync(syncTarget([basename(base)], undefined).source)).toBe(realpathSync(base));
		} finally {
			process.chdir(cwd);
		}
		expect(() => syncTarget([], undefined)).toThrow(/usage/);
	});

	/** The base moved on: `change` edits its tree, and this returns the new export. */
	function nextBase(base: string, change: () => void) {
		change();
		git(base, "add", "-A");
		git(base, "commit", "-q", "-m", "next");
		const next = fetchBase(base, "HEAD");
		made.push(next.dir);
		return next;
	}

	it("replaces a folder the base turned into a file, and leaves no empty folders", () => {
		const { base, product } = synced();
		git(product, "add", "-A");
		git(product, "commit", "-q", "-m", "synced");
		const next = nextBase(base, () => {
			rmSync(join(base, "extensions"), { recursive: true });
			write(base, { extensions: "now a file" });
		});
		applyBase(product, next.dir, { commit: next.commit });
		expect(readFileSync(join(product, "extensions"), "utf8")).toBe("now a file");
	});

	it("stops before overwriting an untracked file the base now brings", () => {
		const { base, product } = synced();
		git(product, "add", "-A");
		git(product, "commit", "-q", "-m", "synced");
		write(product, { "extensions/new.ts": "my draft" });
		const next = nextBase(base, () => write(base, { "extensions/new.ts": "the base's" }));
		expect(() => applyBase(product, next.dir, { commit: next.commit })).toThrow(/extensions\/new\.ts/);
		expect(readFileSync(join(product, "extensions/new.ts"), "utf8")).toBe("my draft");
	});

	// Windows has no executable bit, so the check compares bytes alone there.
	it.skipIf(process.platform === "win32")("reports a base file whose executable bit the product lost", () => {
		const { base, product } = synced();
		const next = nextBase(base, () => {
			write(base, { "scripts/run.sh": "echo hi" });
			chmodSync(join(base, "scripts/run.sh"), 0o755);
		});
		applyBase(product, next.dir, { commit: next.commit });
		expect(checkBase(product, next.dir)).toEqual([]);
		chmodSync(join(product, "scripts/run.sh"), 0o644);
		expect(checkBase(product, next.dir)).toEqual(["scripts/run.sh: differs from the base"]);
	});

	it("never writes through a link at a path the base supplies, in a check or a sync", () => {
		const { product, first } = synced();
		const outside = mkdtempSync(join(tmpdir(), "sync-base-outside-"));
		made.push(outside);
		writeFileSync(join(outside, "target.ts"), "outside");
		rmSync(join(product, "extensions/a.ts"));
		symlinkSync(join(outside, "target.ts"), join(product, "extensions/a.ts"));
		git(product, "add", "-A");
		git(product, "commit", "-q", "-m", "a link where the base has a file");
		expect(checkBase(product, first.dir)).toContain("extensions/a.ts: differs from the base");
		expect(readFileSync(join(outside, "target.ts"), "utf8")).toBe("outside");
		applyBase(product, first.dir, { commit: first.commit });
		expect(lstatSync(join(product, "extensions/a.ts")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(outside, "target.ts"), "utf8")).toBe("outside");
	});

	it("leaves a linked sync record's target alone during a check", () => {
		const { product, first } = synced();
		const outside = mkdtempSync(join(tmpdir(), "sync-base-outside-"));
		made.push(outside);
		const recordText = readFileSync(join(product, SYNC_FILE), "utf8");
		writeFileSync(join(outside, "record.json"), recordText);
		rmSync(join(product, SYNC_FILE));
		symlinkSync(join(outside, "record.json"), join(product, SYNC_FILE));
		checkBase(product, first.dir);
		expect(readFileSync(join(outside, "record.json"), "utf8")).toBe(recordText);
		expect(lstatSync(join(product, SYNC_FILE)).isSymbolicLink()).toBe(true);
	});

	it("refuses a base that holds a symbolic link", () => {
		const { base, product } = synced();
		const next = nextBase(base, () => symlinkSync("a.ts", join(base, "extensions/link.ts")));
		expect(() => applyBase(product, next.dir, { commit: next.commit })).toThrow(/symbolic links[\s\S]*extensions\/link\.ts/);
	});
});
