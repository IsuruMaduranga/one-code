/**
 * workflow/index.ts wiring: the "ultracode" keyword arms a turn with a one-shot
 * reminder, except while `/effort ultracode` already has the standing block on
 * (STEERING-REVIEW-2026-09-05 L3: two instructions for one fact, the weaker one
 * on top).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ULTRACODE_MODE_CHANNEL } from "../../extensions/effort/slider.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import workflowExtension from "../../extensions/workflow/index.ts";
import { createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("workflow wiring: the ultracode keyword", () => {
	let fake: FakePi;
	const reminders: Array<{ text?: string; scope?: string }> = [];

	beforeEach(() => {
		fake = createFakePi();
		reminders.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		workflowExtension(fake.pi as never);
	});

	it("arms the turn with a next-turn one-shot when the keyword is in the prompt", async () => {
		await fake.fire("input", { text: "ultracode: audit every extension", source: "interactive" });
		expect(reminders).toHaveLength(1);
		expect(reminders[0].scope).toBe("next-turn");
		expect(reminders[0].text).toContain('keyword "ultracode"');

		reminders.length = 0;
		await fake.fire("input", { text: "no keyword here", source: "interactive" });
		expect(reminders).toHaveLength(0);
	});

	it("skips the one-shot while ultracode mode is on, and resumes when it is switched off", async () => {
		fake.events.emit(ULTRACODE_MODE_CHANNEL, { active: true });
		await fake.fire("input", { text: "ultracode: audit every extension", source: "interactive" });
		expect(reminders).toHaveLength(0);

		fake.events.emit(ULTRACODE_MODE_CHANNEL, { active: false });
		await fake.fire("input", { text: "ultracode: audit every extension", source: "interactive" });
		expect(reminders).toHaveLength(1);
	});
});
