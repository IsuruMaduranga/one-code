/**
 * Where plan mode puts the profile's texts: enter_plan_mode re-registered with
 * the session model's tier form, the plan-mode block frozen at entry, and the
 * approve and reject results. One Code's wording of each text is checked in
 * profile/test/plan-mode-texts-wording.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { userDenialText } from "../../extensions/lib/consent/user-denial.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/lib/rules/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";

const OPUS = { provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" };
const planMode = requireText("planMode");

describe("plan-mode wiring of the texts", () => {
	let fake: FakePi;
	let stateDir: string;
	const reminders: Array<{ key?: string; text?: string; placement?: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-mode-texts-"));
		vi.stubEnv(envName("STATE_DIR"), stateDir);
		vi.stubEnv("CC_PROMPT_TIER", "");
		fake = createFakePi();
		reminders.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("re-registers enter_plan_mode with the session model's tier text, and only when that text changes", async () => {
		const register = vi.spyOn(fake.pi as { registerTool: (tool: unknown) => void }, "registerTool");
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, model: OPUS }));
		expect(fake.tools.get("enter_plan_mode")!.description).toBe(planMode.descriptions.enter_plan_mode("short"));
		// The load-time registration already carried the frontier text: nothing re-registered.
		expect(register).not.toHaveBeenCalled();

		await fake.fireOne("model_select", { model: HAIKU }, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, model: HAIKU }));
		expect(fake.tools.get("enter_plan_mode")!.description).toBe(planMode.descriptions.enter_plan_mode("long"));
		expect(register).toHaveBeenCalledTimes(1);

		await fake.fireOne("model_select", { model: HAIKU }, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, model: HAIKU }));
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("freezes the Plan File Info line at entry, so the standing block does not change once the plan is written", async () => {
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch } });
		await fake.fireOne("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const first = reminders.find((r) => r.key === "permission-mode")!.text!;

		const entered = (await fake.tools.get("enter_plan_mode")!.execute("t1", {}, undefined, undefined, ctx)) as { details: { planFilePath: string } };
		expect(first).toContain(planMode.reminder({ planFile: entered.details.planFilePath, planExists: false }));
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# Plan\n");
		reminders.length = 0;
		await fake.fireOne("before_agent_start", {}, ctx);
		expect(reminders.find((r) => r.key === "permission-mode")!.text).toBe(first);

		// A later plan-mode run sees the file and says so.
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "default", paused: false });
		reminders.length = 0;
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		expect(reminders.find((r) => r.key === "permission-mode")!.text).toContain(planMode.reminder({ planFile: entered.details.planFilePath, planExists: true }));
	});

	type ViewerComponent = { render: (width: number) => string[]; handleInput: (data: string) => void };
	type ViewerFactory = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => ViewerComponent;
	const answer = (key: string) =>
		vi.fn(async (factory: ViewerFactory) => {
			let picked: unknown;
			const component = factory({ requestRender: () => {} }, {}, {}, (v) => (picked = v));
			component.render(120);
			component.handleInput(key);
			return picked;
		});

	const planned = async (custom: ReturnType<typeof answer>) => {
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom } });
		await fake.fireOne("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const entered = (await fake.tools.get("enter_plan_mode")!.execute("t1", {}, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			details: { planFilePath: string };
		};
		expect(entered.content[0].text).toBe(planMode.entered(entered.details.planFilePath));
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# Plan\n\n1. do it\n");
		reminders.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t2", {}, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		return { result, path: entered.details.planFilePath };
	};

	it("an approval returns the profile's approval text with the plan and queues the exited-plan-mode reminder", async () => {
		const { result, path } = await planned(answer("\r"));
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toBe(planMode.approved({ planFile: path, plan: "# Plan\n\n1. do it\n" }));
		expect(reminders.map((r) => r.text)).toContain(planMode.exited(path));
	});

	it("keeping on planning returns the user's rejection as an error", async () => {
		const { result, path } = await planned(answer("\x1b"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(userDenialText());
		expect(reminders.map((r) => r.text)).not.toContain(expect.stringContaining(planMode.exited(path)));
	});
});
