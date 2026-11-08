/**
 * One Code's wording for the one-shot session note and its interactive
 * counterpart (profile/text/notifications/). Where the base places them is in
 * test/unit/system-prompt-one-shot.test.ts.
 */
import { describe, expect, it } from "vitest";
import { interactiveSessionNote, oneShotSessionNote } from "../../extensions/lib/notifications.ts";

describe("One Code's one-shot session note", () => {
	it("says background work blocks, scheduled jobs never fire, and the session is not interactive", () => {
		const note = oneShotSessionNote();
		expect(note).toContain("runs to completion before its call returns");
		expect(note).toContain("Scheduled and recurring jobs never fire");
		expect(note).toContain("non-interactive one-shot session");
	});

	it("tells a continued session that it is interactive now", () => {
		expect(interactiveSessionNote()).toContain("This session is interactive now");
	});
});
