/**
 * /permissions wiring: a classifier denial is recorded, approving it in the
 * panel lets that exact call run once without the classifier, a retry starts a
 * turn with Claude Code's grant message, and rules added or deleted in the
 * panel land in One Code's own files. The provider call is mocked.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { oneCodeProjectSettingsPath } from "../../extensions/lib/one-code-settings.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const completeMock = vi.mocked(completeSimple);
const reply = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }], usage: {} }) as never;
/** Stage 1 flags the call, stage 2 blocks it under a real rule. */
const blockOnce = () => {
	completeMock.mockResolvedValueOnce(reply("<severity>90</severity>"));
	completeMock.mockResolvedValueOnce(reply("<thinking>deletes outside the project</thinking><severity>90</severity><category>Irreversible Local Destruction</category>"));
};

const ENTER = "\r";
const ESC = "\x1b";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";

type GateResult = { block?: boolean; reason?: string } | undefined;

describe("/permissions wiring", () => {
	let fake: FakePi;
	let home: string;
	let cwd: string;
	let ctx: Record<string, unknown>;
	let screens: string[];
	/** The keys the next panel open presses, then it closes with Esc unless they closed it. */
	let keys: string[];
	const reminders: string[] = [];

	const model = { provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet", cost: { input: 3, output: 15 } };

	beforeEach(async () => {
		completeMock.mockReset();
		home = mkdtempSync(join(tmpdir(), "perm-panel-"));
		cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		screens = [];
		keys = [];
		reminders.length = 0;
		fake = createFakePi();
		fake.events.on(REMINDER_CHANNEL, (data) => void reminders.push((data as { text: string }).text));
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd,
			hasUI: true,
			mode: "interactive",
			model,
			modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(home, "session"), getBranch: () => [] },
			ui: {
				custom: vi.fn(async (factory: (...args: unknown[]) => { render(w: number): string[]; handleInput(d: string): void }) => {
					let closed = false;
					const component = factory({ terminal: { rows: 40 }, requestRender: () => {} }, {}, {}, () => {
						closed = true;
					});
					for (const key of [...keys, ESC]) {
						if (closed) break;
						component.handleInput(key);
						screens.push(component.render(200).join("\n"));
					}
					return null;
				}),
			},
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.fire("input", { text: "clean up the old build directory", source: "interactive" }, ctx);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	const bash = (command: string) => fake.fireOne<GateResult>("tool_call", { toolName: "bash", input: { command }, toolCallId: `t-${Math.random()}` }, ctx);
	/** Open the panel, press `pressed`, then Esc; `screens` holds this open's frames only. */
	const openPanel = async (...pressed: string[]) => {
		keys = pressed;
		screens = [];
		await fake.commands.get("permissions")!.handler("", ctx);
	};
	const notices = () => (ctx._notified as Array<{ message: string }>).map((n) => n.message);
	const outside = () => join(home, "elsewhere");

	it("records a denial, and approving it lets that exact call run once", async () => {
		blockOnce();
		const denied = await bash(`rm -rf ${outside()}`);
		expect(denied?.block).toBe(true);
		expect(notices().some((n) => n.startsWith("bash denied by auto mode · Irreversible Local Destruction · /permissions"))).toBe(true);

		await openPanel(ENTER);
		expect(screens[0]).toContain(`✔ bash(rm -rf ${outside()})  [Irreversible Local Destruction]`);
		// The breadcrumb names what was approved; the grant message rides with it.
		expect(reminders.some((r) => r.includes(`<local-command-stdout>Approved bash(rm -rf ${outside()})</local-command-stdout>`))).toBe(true);
		expect(reminders.some((r) => r.startsWith(`Permission granted for: bash(rm -rf ${outside()}). You may now retry this command`))).toBe(true);
		expect(fake.sentMessages).toHaveLength(0);

		completeMock.mockClear();
		expect(await bash(`rm -rf ${outside()}`)).toBeUndefined();
		expect(completeMock).not.toHaveBeenCalled();
		// Spent: the same call again, and a different one, go to the classifier.
		blockOnce();
		expect((await bash(`rm -rf ${outside()}`))?.block).toBe(true);
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("does not grant a call the user toggled back off, or a changed command", async () => {
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel(ENTER, ENTER);
		expect(reminders.some((r) => r.includes("Approved"))).toBe(false);
		blockOnce();
		expect((await bash(`rm -rf ${outside()}`))?.block).toBe(true);

		await openPanel(ENTER);
		blockOnce();
		expect((await bash(`rm -rf ${outside()} `))?.block).toBe(true);
	});

	it("starts a turn with the grant message on retry", async () => {
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel("r");
		expect(screens[0]).toContain("(retry)");
		expect(fake.sentMessages).toEqual([
			{
				message: {
					customType: "one-code:permission-retry",
					content: `Permission granted for: bash(rm -rf ${outside()}). You may now retry this command if you would like.`,
					display: false,
				},
				options: { triggerTurn: true },
			},
		]);
		expect(notices()).toContain(`Allowed bash(rm -rf ${outside()})`);
		expect(await bash(`rm -rf ${outside()}`)).toBeUndefined();
	});

	it("does not offer a block that judged nothing", async () => {
		completeMock.mockResolvedValue({ stopReason: "error", errorMessage: "boom", content: [] } as never);
		expect((await bash(`rm -rf ${outside()}`))?.block).toBe(true);
		await openPanel();
		expect(screens.join("\n")).not.toContain("Recently denied ]");
	});

	it("adds and deletes a rule in One Code's project file, and leaves Claude Code's files alone", async () => {
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
		// Allow tab (opened first: no denials): Add a new rule…, type, save to the project file.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		const target = oneCodeProjectSettingsPath(cwd, home);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);
		expect(reminders.some((r) => r.includes("<local-command-stdout>Added allow rule Bash(npm test:*) to "))).toBe(true);

		// Rows now: Add a new rule…, Bash(npm test:*), Read (read-only).
		await openPanel(DOWN, DOWN, ENTER);
		expect(screens[2]).toContain("One Code does not edit Claude Code's files.");
		await openPanel(DOWN, ENTER, ENTER);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual([]);
		expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).permissions.allow).toEqual(["Read"]);
		expect(existsSync(join(home, ".onecode", "settings.json"))).toBe(false);
	});

	it("opens on Recently denied when something was denied, and lists the ask and deny tabs", async () => {
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel(RIGHT, RIGHT, RIGHT);
		expect(screens[0]).toContain("One Code won't ask before using allowed tools.");
		expect(screens[1]).toContain("One Code will always ask for confirmation before using these tools.");
		expect(screens[2]).toContain("One Code will always reject requests to use denied tools.");
	});
});
