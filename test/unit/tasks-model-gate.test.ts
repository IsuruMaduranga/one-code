import { afterEach, describe, expect, it, vi } from "vitest";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { launchToolFilter, PRODUCT_DIR, PROFILE_DIR, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { DEFER_CHANNEL, WITHHOLD_CHANNEL } from "../../extensions/lib/request/deferred.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import tasksExtension from "../../extensions/tools/tasks/index.ts";
import { profile as shipped } from "./helpers/default-profile.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/**
 * The tasks extension withholds its four tools from every session model
 * unless the ENABLE_TODO_TOOLS knob turns them on; while withheld the
 * periodic reminder stays quiet and a list restored from the branch stays off
 * screen. With the tools on, the reminder waits for a list to exist.
 */
const TASK_TOOLS = ["task_create", "task_get", "task_list", "task_update"];
const opus = { id: "claude-opus-5-5", provider: "anthropic" };
const deepseek = { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter", cost: { input: 0.15 } };
const small = { id: "qwen/qwen3.6-14b", provider: "openrouter", cost: { input: 0.05 } };
const knob = envName("ENABLE_TODO_TOOLS");

function setup() {
	const fake = createFakePi();
	const withheld: string[] = [];
	const deferred: string[] = [];
	const reminders: unknown[] = [];
	fake.events.on(WITHHOLD_CHANNEL, (d) => withheld.push((d as { name: string }).name));
	fake.events.on(DEFER_CHANNEL, (d) => deferred.push((d as { name: string }).name));
	fake.events.on(REMINDER_CHANNEL, (d) => reminders.push(d));
	tasksExtension(fake.pi as never);
	const run = (name: string, params: Record<string, unknown>, ctx = createFakeCtx({})) => fake.tools.get(name)!.execute("call", params, undefined, undefined, ctx);
	return { fake, withheld, deferred, reminders, run };
}

afterEach(() => {
	vi.unstubAllEnvs();
	setActiveProfileForTest(undefined);
});

describe("tasks: off unless the ENABLE_TODO_TOOLS knob is on", () => {
	for (const model of [opus, deepseek, small]) {
		it(`withholds the task tools from ${model.id} at session start`, async () => {
			vi.stubEnv(knob, "");
			const t = setup();
			t.deferred.length = 0;
			await t.fake.fire("session_start", {}, createFakeCtx({ model }));
			expect(t.withheld).toEqual(TASK_TOOLS);
			expect(t.deferred).toEqual([]);
		});
	}

	it("keeps them for any model while the knob is on, through a model change", async () => {
		vi.stubEnv(knob, "1");
		const t = setup();
		expect(t.deferred).toEqual(TASK_TOOLS);
		await t.fake.fire("session_start", {}, createFakeCtx({ model: opus }));
		await t.fake.fire("model_select", { model: deepseek });
		expect(t.withheld).toEqual([]);
	});

	it("sends no task reminder while the tools are withheld", async () => {
		vi.stubEnv(knob, "");
		const t = setup();
		await t.fake.fire("session_start", {}, createFakeCtx({ model: deepseek }));
		await t.run("task_create", { subject: "A", description: "" });
		for (let i = 0; i < 25; i++) await t.fake.fire("turn_end", {});
		expect(t.reminders).toEqual([]);
	});

	it("with the knob on, reminds only once a list exists", async () => {
		vi.stubEnv(knob, "1");
		const t = setup();
		await t.fake.fire("session_start", {}, createFakeCtx({ model: deepseek }));
		for (let i = 0; i < 25; i++) await t.fake.fire("turn_end", {});
		expect(t.reminders).toEqual([]);
		await t.run("task_create", { subject: "A", description: "" });
		for (let i = 0; i < 10; i++) await t.fake.fire("turn_end", {});
		expect(t.reminders).toHaveLength(1);
	});

	it("sends no task reminder when pi's --exclude-tools removed the task tools, knob on", async () => {
		vi.stubEnv(knob, "1");
		setActiveProfileForTest(resolveProfile(shipped, {}, PROFILE_DIR, PRODUCT_DIR, undefined, launchToolFilter(["--exclude-tools", TASK_TOOLS.join(",")])));
		const t = setup();
		await t.fake.fire("session_start", {}, createFakeCtx({ model: deepseek }));
		// A list can still exist (restored from a branch that had the tools), so the reminder must check the live tools, not only the knob.
		await t.run("task_create", { subject: "A", description: "" });
		for (let i = 0; i < 25; i++) await t.fake.fire("turn_end", {});
		expect(t.reminders).toEqual([]);
	});

	it("keeps a list restored from the branch off screen while the tools are withheld or not live", async () => {
		vi.stubEnv(knob, "1");
		const source = setup();
		const created = (await source.run("task_create", { subject: "Old task", description: "" })) as { details: unknown };
		const branch = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				message: { role: "toolResult", toolCallId: "call", toolName: "task_create", content: [], details: created.details, isError: false, timestamp: 0 },
			},
		];
		const shown = (knobValue: string) => {
			vi.stubEnv(knob, knobValue);
			const t = setup();
			const ctx = createFakeCtx({ mode: "tui", hasUI: true, model: deepseek, sessionManager: { getBranch: () => branch } });
			return t.fake.fire("session_start", {}, ctx).then(() => (ctx.ui as { setWidget: ReturnType<typeof vi.fn> }).setWidget.mock.lastCall);
		};
		expect(await shown("")).toEqual(["cc-tasks", undefined]);
		expect((await shown("1"))?.[1]).toBeTypeOf("function");
		// Knob on, but pi's --exclude-tools removed the tools: nothing can update the list, so it stays off screen.
		setActiveProfileForTest(resolveProfile(shipped, {}, PROFILE_DIR, PRODUCT_DIR, undefined, launchToolFilter(["--exclude-tools", TASK_TOOLS.join(",")])));
		expect(await shown("1")).toEqual(["cc-tasks", undefined]);
	});
});
