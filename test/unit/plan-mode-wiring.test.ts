/**
 * plan-mode/index.ts wiring: the standing plan block must be back on the
 * reminder queue the moment the mode becomes plan — a ctrl+q during a long turn
 * used to leave every remaining request of that turn without it while edits
 * were denied "see the plan-mode reminder" (STEERING-REVIEW-2026-09-05 M3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_FILE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
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
