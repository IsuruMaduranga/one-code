import { describe, expect, it } from "vitest";
import { DEFER_CHANNEL, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import tasksExtension from "../../extensions/tasks/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/**
 * The tasks extension withholds its four tools from a model that runs without
 * them (frontier, Sonnet 5+) and brings them back on a model change; while
 * withheld the periodic reminder stays quiet.
 */
const TASK_TOOLS = ["task_create", "task_get", "task_list", "task_update"];
const opus = { id: "claude-opus-5-5", provider: "anthropic" };
const deepseek = { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter", cost: { input: 0.15 } };

function setup() {
	const fake = createFakePi();
	const withheld: string[] = [];
	const deferred: string[] = [];
	const reminders: unknown[] = [];
	fake.events.on(WITHHOLD_CHANNEL, (d) => withheld.push((d as { name: string }).name));
	fake.events.on(DEFER_CHANNEL, (d) => deferred.push((d as { name: string }).name));
	fake.events.on(REMINDER_CHANNEL, (d) => reminders.push(d));
	tasksExtension(fake.pi as never);
	return { fake, withheld, deferred, reminders };
}

describe("tasks: Claude Code's model gate", () => {
	it("withholds the task tools from Opus 5.5 at session start", async () => {
		const t = setup();
		t.deferred.length = 0;
		await t.fake.fire("session_start", {}, createFakeCtx({ model: opus }));
		expect(t.withheld).toEqual(TASK_TOOLS);
		expect(t.deferred).toEqual([]);
	});

	it("keeps them for DeepSeek, and brings them back when the model changes to it", async () => {
		const t = setup();
		t.deferred.length = 0;
		await t.fake.fire("session_start", {}, createFakeCtx({ model: deepseek }));
		expect(t.withheld).toEqual([]);

		await t.fake.fire("model_select", { model: opus });
		expect(t.withheld).toEqual(TASK_TOOLS);
		await t.fake.fire("model_select", { model: deepseek });
		expect(t.deferred).toEqual(TASK_TOOLS);
		// A repeat of the same state emits nothing.
		await t.fake.fire("model_select", { model: deepseek });
		expect(t.deferred).toEqual(TASK_TOOLS);
	});

	it("sends no task reminder while the tools are withheld", async () => {
		const t = setup();
		await t.fake.fire("session_start", {}, createFakeCtx({ model: opus }));
		for (let i = 0; i < 25; i++) await t.fake.fire("turn_end", {});
		expect(t.reminders).toEqual([]);
	});
});
