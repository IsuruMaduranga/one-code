/**
 * lib/tool-path.ts is a vendored copy of pi's `resolveToCwd` (not exported by
 * the package); this checks it against pi's own function, so a pi upgrade
 * that changes the resolution fails here instead of reopening the file
 * tracker's bypass (TOOLS-REVIEW-2026-09-26 M1).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// pi's internal module (not in the package exports), imported only to compare.
import { resolveToCwd } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { resolveToolPath } from "../../extensions/lib/tool-path.ts";

describe("resolveToolPath", () => {
	const cwd = join(homedir(), "proj");
	const inputs = [
		"config.json",
		"./src/../config.json",
		"/etc/hosts",
		"~",
		"~/proj/config.json",
		"@config.json",
		"@~/x",
		pathToFileURL(join(cwd, "a b.ts")).href,
		"notes\u00a0draft.md",
		"dir\u202Fname/x",
		"~user/x",
		// Git Bash's drive form: mapped to C:\… on Windows, left alone elsewhere, as pi does.
		"/c/Users/u/x.ts",
	];

	it("matches pi's resolveToCwd for every spelling", () => {
		for (const input of inputs) expect(resolveToolPath(input, cwd), input).toBe(resolveToCwd(input, cwd));
	});

	it("expands `~` and strips `@` the way pi does", () => {
		const home = resolve("/home/u");
		expect(resolveToolPath("~/proj/config.json", resolve("/elsewhere"), { home })).toBe(join(home, "proj", "config.json"));
		expect(resolveToolPath("@config.json", join(home, "proj"))).toBe(join(home, "proj", "config.json"));
	});
});
