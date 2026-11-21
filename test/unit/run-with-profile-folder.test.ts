/**
 * scripts/run-with-profile.sh's check of the folder it is given
 * (scripts/lib/profile-folder.mjs): a brand.json, and the default profile's
 * index.ts, which is the folder's own or profiles/<defaultProfile>/index.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileFolderProblem } from "../../scripts/lib/profile-folder.mjs";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "run-with-profile-"));
	made.push(dir);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

describe("run-with-profile's profile folder check", () => {
	it("takes the fixture product, whose default profile sits in profiles/Main/ (the script's own example)", () => {
		expect(profileFolderProblem("test/fixtures/profile")).toBeUndefined();
	});

	it("takes a folder with its own index.ts when the brand names no default", () => {
		expect(profileFolderProblem(folder({ "brand.json": "{}", "index.ts": "" }))).toBeUndefined();
	});

	it("takes the default profile's index.ts in place of the folder's own", () => {
		expect(profileFolderProblem(folder({ "brand.json": JSON.stringify({ profiles: ["Main"], defaultProfile: "Main" }), "profiles/Main/index.ts": "" }))).toBeUndefined();
	});

	it("refuses a folder with no brand.json, or with no index.ts for its default profile", () => {
		expect(profileFolderProblem(folder({ "index.ts": "" }))).toMatch(/no brand\.json/);
		expect(profileFolderProblem(folder({ "brand.json": "{}" }))).toMatch(/no index\.ts/);
		expect(profileFolderProblem(folder({ "brand.json": JSON.stringify({ profiles: ["Main"], defaultProfile: "Main" }), "index.ts": "" }))).toMatch(/no profiles[\\/]Main[\\/]index\.ts/);
		expect(profileFolderProblem(folder({ "brand.json": "{" }))).toMatch(/not valid JSON/);
	});

	it("refuses a default profile the harness would refuse, before building a path from it", () => {
		// profiles/../../outside/index.ts exists, so only the id check stops these.
		const parent = folder({ "outside/index.ts": "" });
		const product = join(parent, "product");
		mkdirSync(product);
		writeFileSync(join(product, "brand.json"), JSON.stringify({ defaultProfile: "../../outside" }));
		mkdirSync(join(product, "profiles"));
		expect(profileFolderProblem(product)).toMatch(/"defaultProfile" must be one of the ids in "profiles"/);
		// Listed, but not a profile id.
		writeFileSync(join(product, "brand.json"), JSON.stringify({ profiles: ["../../outside"], defaultProfile: "../../outside" }));
		expect(profileFolderProblem(product)).toMatch(/"profiles" must be an array of profile ids/);
		// A valid id the list does not hold, though its folder exists.
		expect(profileFolderProblem(folder({ "brand.json": JSON.stringify({ profiles: ["Main"], defaultProfile: "Other" }), "profiles/Other/index.ts": "" }))).toMatch(/"defaultProfile" must be one of the ids/);
		expect(profileFolderProblem(folder({ "brand.json": "[]" }))).toMatch(/not a JSON object/);
	});
});
