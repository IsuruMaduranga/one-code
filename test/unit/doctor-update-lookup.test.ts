import { describe, expect, it } from "vitest";
import { HOMEBREW_MIN_RELEASE_AGE_MS } from "../../extensions/lib/update-check.mjs";
import { APP_REGISTRY_URL, PACKAGE_REGISTRY_URL, lookupLatestVersion } from "../../extensions/doctor/update-lookup.ts";

const DAY = 24 * 60 * 60 * 1000;

function packument(latest: string, ages: Record<string, number>) {
	const now = Date.now();
	const time: Record<string, string> = {};
	for (const [version, ageMs] of Object.entries(ages)) time[version] = new Date(now - ageMs).toISOString();
	return { "dist-tags": { latest }, time };
}

const fetching = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("doctor update lookup shares the app's newest-installable-version rule", () => {
	it("reads the full packument of the right package", () => {
		expect(APP_REGISTRY_URL).toBe("https://registry.npmjs.org/@one-ai%2Fone-code");
		expect(PACKAGE_REGISTRY_URL).toBe("https://registry.npmjs.org/one-code-extension");
	});

	it("reports an hour-old release as behind for npm and current for Homebrew", async () => {
		const doc = packument("0.4.0", { "0.3.1": 9 * DAY, "0.4.0": 60 * 60 * 1000 });
		const npm = await lookupLatestVersion({ install: "app", current: "0.3.1", env: { ONECODE_INSTALL_METHOD: "npm" }, fetchImpl: fetching(doc) });
		expect(npm).toEqual({ status: "behind", version: "0.4.0" });
		const brew = await lookupLatestVersion({ install: "app", current: "0.3.1", env: { ONECODE_INSTALL_METHOD: "brew" }, fetchImpl: fetching(doc) });
		expect(brew).toEqual({ status: "current", version: "0.3.1" });
		// A day later Homebrew can install it, and the doctor says so.
		const later = packument("0.4.0", { "0.3.1": 9 * DAY, "0.4.0": HOMEBREW_MIN_RELEASE_AGE_MS + 60_000 });
		expect(await lookupLatestVersion({ install: "app", current: "0.3.1", env: { ONECODE_INSTALL_METHOD: "brew" }, fetchImpl: fetching(later) })).toEqual({ status: "behind", version: "0.4.0" });
	});

	it("labels a packument with nothing old enough as a Homebrew wait, not a broken registry", async () => {
		const fresh = packument("0.1.0", { "0.1.0": 60_000 });
		const brew = await lookupLatestVersion({ install: "app", current: "0.1.0", env: { ONECODE_INSTALL_METHOD: "brew" }, fetchImpl: fetching(fresh) });
		expect(brew.status).toBe("unknown");
		expect(brew.reason).toMatch(/Homebrew/);
		const npm = await lookupLatestVersion({ install: "app", current: "0.1.0", env: {}, fetchImpl: fetching({ nothing: true }) });
		expect(npm).toEqual({ status: "unknown", reason: "unexpected registry payload" });
	});
});
