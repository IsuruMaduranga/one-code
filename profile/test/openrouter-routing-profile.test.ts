import { describe, expect, it } from "vitest";
import { profile } from "../index.ts";

describe("One Code's OpenRouter routing defaults", () => {
	it("are none: which hosts serve a model is the user's choice, and the notices name a host worth leaving out", () => {
		expect(profile.openRouterRouting).toBeUndefined();
	});
});
