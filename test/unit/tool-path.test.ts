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
import { normalizeToolPath, resolveToolPath } from "../../extensions/lib/tool-path.ts";

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

describe("normalizeToolPath", () => {
	it("normalizes like pi's resolveToCwd without resolving", () => {
		const linux = { home: "/home/u", platform: "linux" as const };
		expect(normalizeToolPath("~", linux)).toBe("/home/u");
		expect(normalizeToolPath("~/a", linux)).toBe("/home/u/a");
		expect(normalizeToolPath("@/abs/a", linux)).toBe("/abs/a");
		expect(normalizeToolPath("@src/a", linux)).toBe("src/a");
		expect(normalizeToolPath("a\u00A0b.ts", linux)).toBe("a b.ts");
		expect(normalizeToolPath("file:///x/y.ts", linux)).toBe("/x/y.ts");
		expect(normalizeToolPath("/c/proj/a.ts", { home: "C:\\Users\\u", platform: "win32" })).toBe("C:\\proj\\a.ts");
		expect(normalizeToolPath("/c/proj/a.ts", linux)).toBe("/c/proj/a.ts");
	});
});
