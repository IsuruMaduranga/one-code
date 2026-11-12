/**
 * One Code's committed package.json files carry its brand: the app and the
 * extension package were stamped from profile/brand.json, so the check mode
 * of the stamping script finds nothing to change.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

describe("apply-brand", () => {
	it("leaves the committed package.json files as they are: they match the brand", () => {
		const run = spawnSync(process.execPath, [join(ROOT, "scripts", "apply-brand.mjs"), "--check"], { encoding: "utf8" });
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
	});
});
