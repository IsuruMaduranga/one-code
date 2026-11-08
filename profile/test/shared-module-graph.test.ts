/**
 * One Code's profile has a source provider, so the base's check that the
 * provider's module graph imports no pi package as a value
 * (test/unit/shared-module-graph.test.ts) walks a real graph here.
 */
import { describe, expect, it } from "vitest";
import { profile } from "../index.ts";

describe("One Code's source provider", () => {
	it("is named by the profile", () => {
		expect(profile.sources).toBeDefined();
	});
});
