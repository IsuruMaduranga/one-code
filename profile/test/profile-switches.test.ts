/**
 * One Code's own switches: it runs every feature and turns off pi's search
 * tools, so every tier searches through the shell, and task_output, which
 * Claude Code 2.1.327 does not have (findings §94).
 */
import { describe, expect, it } from "vitest";
import { activeProfile } from "../../extensions/lib/profile/profile.ts";

describe("One Code's shipped profile", () => {
	it("turns off pi's search tools and task_output, and gives child sessions no extension of its own", () => {
		const shipped = activeProfile();
		expect([...shipped.tools]).toEqual([["grep", { enabled: false }], ["find", { enabled: false }], ["ls", { enabled: false }], ["task_output", { enabled: false }]]);
		expect(shipped.childExtensionPaths).toEqual([]);
	});
});
