/**
 * One Code's own switches: it runs every feature and turns off only pi's
 * search tools, so every tier searches through the shell.
 */
import { describe, expect, it } from "vitest";
import { activeProfile } from "../../extensions/lib/profile/profile.ts";

describe("One Code's shipped profile", () => {
	it("turns off only pi's search tools, and gives child sessions no extension of its own", () => {
		const shipped = activeProfile();
		expect([...shipped.tools]).toEqual([["grep", { enabled: false }], ["find", { enabled: false }], ["ls", { enabled: false }]]);
		expect(shipped.childExtensionPaths).toEqual([]);
	});
});
