import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkTree } from "../../extensions/lib/shell/paths.ts";

/**
 * walkTree decides to descend from the directory entry it got while listing
 * the parent, and reads the queued folder later. A folder swapped for a
 * symbolic link in between must not be read through the link: the walk would
 * list a folder outside its root under in-root names.
 */
describe.skipIf(process.platform === "win32")("walkTree and a folder swapped for a link", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("does not list a queued folder that became a symbolic link before it was read", () => {
		const base = realpathSync.native(mkdtempSync(join(tmpdir(), "walk-tree-")));
		dirs.push(base);
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(join(root, "sub"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "x");
		const seen: string[] = [];
		const outcome = walkTree(
			root,
			(relative) => {
				seen.push(relative);
				if (relative === "sub") {
					rmSync(join(root, "sub"), { recursive: true });
					symlinkSync(outside, join(root, "sub"));
				}
				return undefined;
			},
			100,
		);
		expect(outcome).toBe("done");
		expect(seen).toEqual(["sub"]);
	});

	it("still walks real folders below the root", () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "walk-tree-")));
		dirs.push(root);
		mkdirSync(join(root, "a", "b"), { recursive: true });
		writeFileSync(join(root, "a", "b", "f.txt"), "x");
		const seen: string[] = [];
		walkTree(root, (relative) => void seen.push(relative), 100);
		expect(seen.sort()).toEqual(["a", join("a", "b"), join("a", "b", "f.txt")]);
	});
});
