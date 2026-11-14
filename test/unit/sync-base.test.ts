/**
 * scripts/sync-base.mjs: a product's repository holds the base byte for byte
 * outside its own paths, and only a sync writes it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBase, checkBase, fetchBase, isProductPath, PRODUCT_PATHS, SYNC_FILE } from "../../scripts/sync-base.mjs";

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
});
