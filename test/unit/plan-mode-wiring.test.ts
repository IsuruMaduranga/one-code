/**
 * plan-mode/index.ts wiring: the standing plan block must be back on the
 * reminder queue the moment the mode becomes plan — a ctrl+q during a long turn
 * used to leave every remaining request of that turn without it while edits
 * were denied "see the plan-mode reminder" (STEERING-REVIEW-2026-09-05 M3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODE_CHANNEL, PLAN_FILE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("plan-mode wiring", () => {
	let fake: FakePi;
	let stateDir: string;
	const reminders: Array<{ key?: string; text?: string; placement?: string; scope?: string; remove?: boolean }> = [];
	const planFiles: Array<{ path: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-mode-wiring-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		reminders.length = 0;
		planFiles.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		fake.events.on(PLAN_FILE_CHANNEL, (data) => planFiles.push(data as never));
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("re-installs the sticky plan block and announces the plan file synchronously when the mode becomes plan mid-turn", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir }));
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });

		expect(planFiles).toHaveLength(1);
		const standing = reminders.find((r) => r.key === "permission-mode" && !r.remove);
		expect(standing).toBeDefined();
		expect(standing?.placement).toBe("sticky-append");
		expect(standing?.scope).toBe("every-turn");
		expect(standing?.text).toContain(planFiles[0].path);

		// Staying in plan mode (a repeated status broadcast) does not re-emit; leaving does nothing here.
		reminders.length = 0;
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "default", paused: false });
		expect(reminders).toHaveLength(0);
	});

	it("without a context yet (a session that starts in plan mode), before_agent_start installs the block", async () => {
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		expect(reminders).toHaveLength(0);
		await fake.fireOne("before_agent_start", {}, createFakeCtx({ cwd: stateDir }));
		expect(reminders.find((r) => r.key === "permission-mode")?.placement).toBe("sticky-append");
	});
});

describe("exit_plan_mode and the mode before planning (PERMISSIONS-REVIEW-2026-09-05 M4)", () => {
	let fake: FakePi;
	let stateDir: string;
	const modeRequests: Array<{ mode?: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-mode-exit-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		modeRequests.length = 0;
		fake.events.on(MODE_CHANNEL, (data) => modeRequests.push(data as never));
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	/** Enter plan mode (status broadcast + tool) and write a plan into the allocated file. */
	const enterPlanWithPlanText = async (ctx: Record<string, unknown>) => {
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const entered = (await fake.tools.get("enter_plan_mode")!.execute("t1", {}, undefined, undefined, ctx)) as {
			details: { planFilePath: string };
		};
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# The plan\n\n1. do it\n");
		return entered.details.planFilePath;
	};

	type ViewerComponent = { render: (width: number) => string[]; handleInput: (data: string) => void };
	type ViewerFactory = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => ViewerComponent;
	/** A `ctx.ui.custom` that renders the approval viewer once (capturing the choices) and confirms the pre-selected option. */
	const confirmPreselected = (offered: string[][]) =>
		vi.fn(async (factory: ViewerFactory) => {
			let picked: unknown;
			const component = factory({ requestRender: () => {} }, {}, {}, (v) => (picked = v));
			offered.push(component.render(120));
			component.handleInput("\r");
			return picked;
		});

	it("headless: refuses to leave plan mode and points at the plan file (the model used to exit by itself)", async () => {
		const ctx = createFakeCtx({ cwd: stateDir, hasUI: false });
		await fake.fireOne("session_start", {}, ctx);
		const planFile = await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t2", {}, undefined, undefined, ctx)) as {
			isError?: boolean;
			content: Array<{ text: string }>;
			details: { approved?: boolean };
		};
		expect(result.isError).toBe(true);
		expect(result.details.approved).toBe(false);
		expect(result.content[0].text).toContain("interactive session");
		expect(result.content[0].text).toContain(planFile);
		// No mode change was requested: the session stays in plan mode.
		expect(modeRequests).toHaveLength(0);
	});

	it("interactive: the mode the session was in before planning is offered first and pre-selected", async () => {
		const offered: string[][] = [];
		const ctx = createFakeCtx({
			cwd: stateDir,
			hasUI: true,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			ui: { custom: confirmPreselected(offered) },
		});
		await fake.fireOne("session_start", {}, ctx);
		// The session was in acceptEdits, then entered plan mode.
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "acceptEdits", paused: false });
		await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;

		const result = (await fake.tools.get("exit_plan_mode")!.execute("t3", {}, undefined, undefined, ctx)) as { details: { approved?: boolean } };
		expect(result.details.approved).toBe(true);
		expect(modeRequests).toEqual([{ mode: "acceptEdits" }]);
		const text = offered[0].join("\n");
		expect(text).toContain("back to auto-accept edits (the mode before planning)");
		// The fixed choice for the same mode is not listed twice; auto is still offered.
		expect(text.match(/auto-accept edits/g)).toHaveLength(1);
		expect(text).toContain("Approve — auto mode");
	});

	it("a session that STARTED in plan mode has no pre-plan mode: the fixed list, manual approvals pre-selected", async () => {
		const offered: string[][] = [];
		const ctx = createFakeCtx({ cwd: stateDir, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom: confirmPreselected(offered) } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx); // the first status seen is plan itself
		modeRequests.length = 0;
		await fake.tools.get("exit_plan_mode")!.execute("t4", {}, undefined, undefined, ctx);
		expect(modeRequests).toEqual([{ mode: "default" }]);
		expect(offered[0].join("\n")).not.toContain("the mode before planning");
	});
});
