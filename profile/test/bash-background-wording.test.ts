/** One Code's marker for a background shell's output cut to its tail. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("tail marker wording", () => {
	it("says earlier output was truncated", () => {
		expect(requireText("shell").earlierTruncated).toContain("earlier output truncated");
	});
});
