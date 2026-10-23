/**
 * A one-shot session (`-p`, `--mode json`) gets One Code's note up front:
 * background work blocks, scheduled jobs never fire, nobody can answer.
 * An interactive session does not (lib/notifications.ts oneShotSessionNote).
 */
import { describe, expect, it } from "vitest";
import systemPromptExtension from "../../extensions/system-prompt/index.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, toldBlockFact } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, renderRequest } from "./helpers/fake-pi.ts";

const queued = async (mode: string) => {
	const fake = createFakePi();
	systemPromptExtension(fake.pi as never);
	const reminders: { key?: string; text: string; placement?: string; order?: number; remove?: boolean }[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
	await fake.fire("turn_start", {}, createFakeCtx({ mode }));
	return reminders.filter((reminder) => reminder.key === "one-shot" && !reminder.remove);
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

describe("system-prompt: what changed since message 1 (R3-M11, R3-M12)", () => {
	const mounted = async (mode: string) => {
		const fake = createFakePi();
		systemPromptExtension(fake.pi as never);
		const ctx = createFakeCtx({ mode });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.fire("turn_start", {}, ctx);
		return fake;
	};

	it("tells a one-shot epoch continued in the TUI that the session is interactive now, once", async () => {
		const fake = await mounted("tui");
		const blocks = renderRequest(fake.events, { facts: [{ kind: "mode", key: "one-shot", on: true }, toldBlockFact("environment:scratchpad", "")] });
		expect(blocks.map((block) => block.text).join("\n")).toContain("This session is interactive now");
		expect(renderRequest(fake.events, { facts: [{ kind: "mode", key: "one-shot", on: false }] })).toEqual([]);
	});

	it("tells an interactive epoch continued in print mode that it is one-shot now", async () => {
		const fake = await mounted("print");
		const blocks = renderRequest(fake.events, { facts: [] });
		expect(blocks.map((block) => block.text).join("\n")).toContain("non-interactive one-shot session");
	});

	it("names the scratchpad when the epoch's message 1 named another session's (a /fork)", async () => {
		const fake = await mounted("tui");
		const blocks = renderRequest(fake.events, { facts: [toldBlockFact("environment:scratchpad", "/tmp/claude-501/parent-session/scratchpad")] });
		expect(blocks.some((block) => block.text.includes("scratchpad directory is now"))).toBe(true);
	});
});
