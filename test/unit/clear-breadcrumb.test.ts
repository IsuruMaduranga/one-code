import { describe, expect, it } from "vitest";
import clearExtension from "../../extensions/clear/index.ts";
import { localCommandBlocks } from "../../extensions/lib/local-command.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

function mount() {
	const fake = createFakePi();
	const emitted: Array<{ text?: string }> = [];
	fake.events.on(REMINDER_CHANNEL, (data) => void emitted.push(data as { text?: string }));
	clearExtension(fake.pi as never);
	let newSessions = 0;
	const ctx = { newSession: async () => void newSessions++ };
	return { fake, emitted, ctx, count: () => newSessions };
}

describe("/clear breadcrumb", () => {
	it("resets the session and announces the clear from the NEW session's start (reason 'new')", async () => {
		const { fake, emitted, ctx, count } = mount();
		await fake.commands.get("clear")!.handler("", ctx as never);
		expect(count()).toBe(1);
		expect(emitted).toEqual([]); // the old queue dies with the old runtime
		await fake.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		expect(emitted.map((e) => e.text)).toEqual(localCommandBlocks({ name: "clear" }));
	});

	it("stays silent on a startup, resume, fork or reload session_start", async () => {
		const { fake, emitted, ctx } = mount();
		for (const reason of ["startup", "resume", "fork", "reload"]) await fake.fire("session_start", { type: "session_start", reason }, ctx);
		expect(emitted).toEqual([]);
	});
});
