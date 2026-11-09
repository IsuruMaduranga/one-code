/** One Code's message for a denied call the user then approved: Claude Code's words. */
import { describe, expect, it } from "vitest";
import { permissionGrantedMessage } from "../../extensions/safety/permissions/auto-mode/denials.ts";

describe("permissionGrantedMessage", () => {
	it("uses Claude Code's wording", () => {
		expect(permissionGrantedMessage(["bash(rm -rf dist)"])).toBe("Permission granted for: bash(rm -rf dist). You may now retry this command if you would like.");
		expect(permissionGrantedMessage(["a", "b"])).toBe("Permission granted for: a, b. You may now retry these commands if you would like.");
	});
});
