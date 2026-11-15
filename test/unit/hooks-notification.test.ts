import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/safety/hooks/index.ts";
import { runHookCommand } from "../../extensions/safety/hooks/executor.ts";
import { DESKTOP_NOTIFICATION_CHANNEL } from "../../extensions/lib/notify/desktop.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";

vi.mock("../../extensions/safety/hooks/executor.ts", () => ({ runHookCommand: vi.fn() }));
const USER_SOURCES = [
	{
		scope: "user",
		config: {
			Notification: [
				{ matcher: "permission_prompt", hooks: [{ type: "command", command: "on-permission" }] },
				{ hooks: [{ type: "command", command: "on-any" }] },
			],
		},
	},
];
const settings = vi.hoisted(() => ({ sources: [] as unknown[] }));
vi.mock("../../extensions/safety/hooks/settings.ts", () => ({ loadHookSettings: () => ({ diagnostics: [], sources: settings.sources }) }));
vi.mock("../../extensions/safety/hooks/plugin-hooks.ts", () => ({ loadPluginHooks: () => [] }));

const hook = vi.mocked(runHookCommand);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The consent store lives under the product's state dir: keep it in a temp dir.
const stateDir = mkdtempSync(join(tmpdir(), "oc-hooks-notification-"));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

beforeEach(() => {
	settings.sources = USER_SOURCES;
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

	it("never ask for project-hook consent: unapproved project hooks are skipped until another event's prompt approves them", async () => {
		vi.stubEnv(envName("STATE_DIR"), stateDir);
		settings.sources = [
			{ scope: "project", path: "/p/.claude/settings.json", config: { Notification: [{ hooks: [{ type: "command", command: "project-notify" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "project-prompt" }] }] } },
		];
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		const confirm = vi.fn(async () => true);
		const ctx = createFakeCtx({ hasUI: true, cwd: mkdtempSync(join(stateDir, "project-")) });
		(ctx.ui as { confirm: unknown }).confirm = confirm;
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await settle();

		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod is waiting for your input", notificationType: "idle_prompt" });
		await settle();
		expect(confirm).not.toHaveBeenCalled();
		expect(hook).not.toHaveBeenCalled();

		// The normal route: a prompt's UserPromptSubmit asks, the user approves.
		await fake.fire("input", { text: "hi", source: "interactive" }, ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(hook.mock.calls.map((call) => call[0])).toEqual(["project-prompt"]);

		hook.mockClear();
		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod is waiting for your input", notificationType: "idle_prompt" });
		await settle();
		expect(hook.mock.calls.map((call) => call[0])).toEqual(["project-notify"]);
		expect(confirm).toHaveBeenCalledTimes(1);
		vi.unstubAllEnvs();
	});

	it("asks at the user's next prompt for a project whose only hooks are Notification hooks, never when one fires", async () => {
		vi.stubEnv(envName("STATE_DIR"), stateDir);
		settings.sources = [{ scope: "project", path: "/p/.claude/settings.json", config: { Notification: [{ hooks: [{ type: "command", command: "project-ping" }] }] } }];
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		const confirm = vi.fn(async () => true);
		const ctx = createFakeCtx({ hasUI: true, cwd: mkdtempSync(join(stateDir, "only-notification-")) });
		(ctx.ui as { confirm: unknown }).confirm = confirm;
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await settle();
		// Nothing asks at startup (no SessionStart hook) or when the notification fires.
		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod is waiting for your input", notificationType: "idle_prompt" });
		await settle();
		expect(confirm).not.toHaveBeenCalled();
		expect(hook).not.toHaveBeenCalled();
		// The user types a prompt: the dialog covers the Notification hooks too.
		await fake.fire("input", { text: "hi", source: "interactive" }, ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(hook).not.toHaveBeenCalled();
		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod is waiting for your input", notificationType: "idle_prompt" });
		await settle();
		expect(hook.mock.calls.map((call) => call[0])).toEqual(["project-ping"]);
		expect(confirm).toHaveBeenCalledTimes(1);
		vi.unstubAllEnvs();
	});

	it("keeps a declined project's Notification hooks skipped and asks no more this session", async () => {
		vi.stubEnv(envName("STATE_DIR"), stateDir);
		settings.sources = [{ scope: "project", path: "/p/.claude/settings.json", config: { Notification: [{ hooks: [{ type: "command", command: "project-ping-2" }] }] } }];
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		const confirm = vi.fn(async () => false);
		const ctx = createFakeCtx({ hasUI: true, cwd: mkdtempSync(join(stateDir, "declined-")) });
		(ctx.ui as { confirm: unknown }).confirm = confirm;
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await settle();
		await fake.fire("input", { text: "hi", source: "interactive" }, ctx);
		await fake.fire("input", { text: "again", source: "interactive" }, ctx);
		fake.events.emit(DESKTOP_NOTIFICATION_CHANNEL, { message: "Prod is waiting for your input", notificationType: "idle_prompt" });
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(hook).not.toHaveBeenCalled();
		vi.unstubAllEnvs();
	});
});
