/** With the plan-mode feature off, no flag starts a session in plan mode: the model would have no exit_plan_mode to leave it. */
import { afterEach, describe, expect, it } from "vitest";
import { MODE_ENV } from "../../extensions/lib/agents/permission-gate.ts";
import { activeProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import permissionsExtension from "../../extensions/safety/permissions/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { tempHome } from "./helpers/temp-home.ts";

describe("--permission-mode plan", () => {
	afterEach(() => setActiveProfileForTest(undefined));

	async function startedIn(planMode: boolean): Promise<{ mode: string | undefined; notices: unknown }> {
		const { cwd } = tempHome("plan-off-");
		const features = new Set(activeProfile().features);
		if (!planMode) features.delete("plan-mode");
		setActiveProfileForTest({ ...activeProfile(), features });
		const fake = createFakePi();
		permissionsExtension(fake.pi as never);
		fake.flags.set("permission-mode", "plan");
		const ctx = createFakeCtx({
			cwd,
			hasUI: true,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "plan-off", getSessionDir: () => cwd, getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		return { mode: process.env[MODE_ENV], notices: ctx._notified };
	}

	it("starts in plan mode while the feature is on", async () => {
		expect((await startedIn(true)).mode).toBe("plan");
	});

	it("starts in another mode and says why when the feature is off", async () => {
		const { mode, notices } = await startedIn(false);
		expect(mode).not.toBe("plan");
		expect(notices).toContainEqual({ message: "Plan mode is turned off in this profile, so the session starts in another mode", type: "warning" });
	});
});
