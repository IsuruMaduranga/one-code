/**
 * A one-shot session (`-p`, `--mode json`) gets One Code's note up front:
 * background work blocks, scheduled jobs never fire, nobody can answer.
 * An interactive session does not (lib/notifications.ts oneShotSessionNote).
 */
import { describe, expect, it } from "vitest";
import systemPromptExtension from "../../extensions/system-prompt/index.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const queued = async (mode: string) => {
	const fake = createFakePi();
	systemPromptExtension(fake.pi as never);
	const reminders: { key?: string; text: string; placement?: string; order?: number }[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
	await fake.fire("turn_start", {}, createFakeCtx({ mode }));
	return reminders.filter((reminder) => reminder.key === "one-shot");
};

describe("system-prompt: the one-shot session note", () => {
	it("queues the note on the first message in print and json mode", async () => {
		for (const mode of ["print", "json"]) {
			const [note] = await queued(mode);
			expect(note?.placement, mode).toBe("first-prepend");
			expect(note?.order).toBe(CONTEXT_ORDER.oneShot);
			expect(note?.text).toContain("runs to completion before its call returns");
			expect(note?.text).toContain("Scheduled and recurring jobs never fire");
		}
	});

	it("queues nothing in an interactive session", async () => {
		for (const mode of ["tui", "rpc"]) expect(await queued(mode), mode).toEqual([]);
	});
});
