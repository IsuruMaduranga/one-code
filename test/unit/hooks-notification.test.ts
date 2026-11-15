import { beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/safety/hooks/index.ts";
import { runHookCommand } from "../../extensions/safety/hooks/executor.ts";
import { DESKTOP_NOTIFICATION_CHANNEL } from "../../extensions/lib/notify/desktop.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("../../extensions/safety/hooks/executor.ts", () => ({ runHookCommand: vi.fn() }));
vi.mock("../../extensions/safety/hooks/settings.ts", () => ({
	loadHookSettings: () => ({
		diagnostics: [],
		sources: [
			{
				scope: "user",
				config: {
					Notification: [
						{ matcher: "permission_prompt", hooks: [{ type: "command", command: "on-permission" }] },
						{ hooks: [{ type: "command", command: "on-any" }] },
					],
				},
			},
		],
	}),
}));
vi.mock("../../extensions/safety/hooks/plugin-hooks.ts", () => ({ loadPluginHooks: () => [] }));

const hook = vi.mocked(runHookCommand);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
	hook.mockReset();
	hook.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 1 });
});

describe("Notification hooks", () => {
	it("run with Claude Code's payload, matched on notification_type, and stop at session_shutdown", async () => {
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		const ctx = createFakeCtx({ hasUI: true });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await settle();
		hook.mockClear();

		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod needs your permission to use Bash", notificationType: "permission_prompt" });
		await settle();
		expect(hook.mock.calls.map((call) => call[0]).sort()).toEqual(["on-any", "on-permission"]);
		const payload = JSON.parse(hook.mock.calls[0][1] as string);
		expect(payload).toMatchObject({ hook_event_name: "Notification", message: "Prod needs your permission to use Bash", notification_type: "permission_prompt" });
		expect(payload).not.toHaveProperty("title");

		hook.mockClear();
		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod is waiting for your input", notificationType: "idle_prompt" });
		await settle();
		expect(hook.mock.calls.map((call) => call[0])).toEqual(["on-any"]);

		hook.mockClear();
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
		await settle();
		hook.mockClear();
		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "late", notificationType: "idle_prompt" });
		await settle();
		expect(hook).not.toHaveBeenCalled();
	});
});
