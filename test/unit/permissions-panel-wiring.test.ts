/**
 * /permissions wiring: a classifier denial is recorded, approving it in the
 * panel lets that exact call run once without the classifier, a retry starts a
 * turn with the profile's grant message, and rules added or deleted in the
 * panel land in the product's own files. The provider call is mocked. How the
 * panel treats another tool's settings files a source provider adds is the
 * provider's to test (One Code's: profile/test/permissions-panel-claude-files.test.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { completeSimple as CompleteSimple } from "@earendil-works/pi-ai/compat";
import { registryStream } from "./helpers/side-call-registry.ts";
import { productProjectSettingsPath, productSettingsPath } from "../../extensions/lib/profile/product-settings.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import permissionsExtension from "../../extensions/safety/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { brand, brandedId, productStateDir } from "../../extensions/lib/profile/brand.mjs";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { defaultEnvironment } from "../../extensions/safety/permissions/auto-mode/classifier-prompt.ts";
import { indexFor } from "../../extensions/safety/permissions/auto-mode/prompt.ts";
import { autoModeResultText } from "../../extensions/safety/permissions/auto-mode/text.ts";
import { ORIGINAL_COMMAND_CHANNEL } from "../../extensions/lib/shell/original-command.ts";
import { type ActiveSandbox, sandboxedCommand, setSandboxForTest } from "../../extensions/lib/shell-run/sandbox.ts";
import { SANDBOX_OFF } from "../../extensions/lib/shell-run/sandbox-settings.ts";

/** Stands in for the provider behind the model registry's stream (helpers/side-call-registry.ts). */
const completeSimple = vi.fn<typeof CompleteSimple>();

const completeMock = vi.mocked(completeSimple);
const granted = (display: string) => autoModeResultText.permissionGranted({ displays: [display] });
/** A real block rule of the profile's ruleset, so the classifier's verdict grounds to it. */
const RULE = indexFor(defaultEnvironment()).rules.find((rule) => rule.tier === "soft_deny")!.name;
const reply = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }], usage: {} }) as never;
/** Stage 1 flags the call, stage 2 blocks it under a real rule. */
const blockOnce = () => {
	completeMock.mockResolvedValueOnce(reply("<severity>90</severity>"));
	completeMock.mockResolvedValueOnce(reply(`<thinking>deletes outside the project</thinking><severity>90</severity><category>${RULE}</category>`));
};

const ENTER = "\r";
const ESC = "\x1b";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const PAGE_DOWN = "\x1b[6~";

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
	/** What the fake environment editor returns, given its prefill. */
	let editorReply: (prefill: string) => string | undefined = (prefill) => prefill;

	const model = { provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet", cost: { input: 3, output: 15 } };

	beforeEach(async () => {
		completeMock.mockReset();
		home = mkdtempSync(join(tmpdir(), "perm-panel-"));
		cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		stubHome(home);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		screens = [];
		keys = [];
		editorReply = (prefill) => prefill;
		reminders.length = 0;
		fake = createFakePi();
		fake.events.on(REMINDER_CHANNEL, (data) => void reminders.push((data as { text: string }).text));
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd,
			hasUI: true,
			mode: "interactive",
			model,
			modelRegistry: { getAvailable: () => [model], streamSimple: registryStream(completeSimple), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(home, "session"), getBranch: () => [] },
			ui: {
				editor: vi.fn(async (_title: string, prefill: string) => editorReply(prefill)),
				custom: vi.fn(async (factory: (...args: unknown[]) => { render(w: number): string[]; handleInput(d: string): void }) => {
					let closed = false;
					const component = factory({ terminal: { rows: 40 }, requestRender: () => {} }, {}, {}, () => {
						closed = true;
					});
					// A reopened panel (after the environment editor) gets no replay of the keys.
					const pressing = keys;
					keys = [];
					for (const key of [...pressing, ESC]) {
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
		setSandboxForTest(undefined);
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
	/** Forward-slashed: bash reads a Windows backslash as an escape, which would make the path relative. */
	// A short fixed path outside the project, whatever TMPDIR is: the panel clips
	// a long subject. Never created; the classifier is stubbed.
	const outside = () => "/outside-perm-panel/elsewhere";

	it("records Claude Code's dismissal text when the permissions panel closes unchanged", async () => {
		await openPanel();
		expect(reminders).toContain("<local-command-stdout>Permissions dialog dismissed</local-command-stdout>\n");
		expect(fake.sentMessages).toEqual([]);
	});

	it("an allowed call ends a consecutive-limit pause, so the next call is classified again", async () => {
		for (let i = 0; i < 3; i++) {
			blockOnce();
			expect((await bash(`rm -rf ${outside()}`))?.block).toBe(true);
		}
		expect(completeMock).toHaveBeenCalledTimes(6);
		// A read-only command is allowed without the classifier, and breaks the streak.
		expect(await bash("ls")).toBeUndefined();
		blockOnce();
		expect((await bash(`rm -rf ${outside()}`))?.block).toBe(true);
		expect(completeMock).toHaveBeenCalledTimes(8);
	});

	it("records a denial, and approving it lets that exact call run once", async () => {
		blockOnce();
		const denied = await bash(`rm -rf ${outside()}`);
		expect(denied?.block).toBe(true);
		expect(notices().some((n) => n.startsWith(`bash denied by auto mode · ${RULE.length > 80 ? `${RULE.slice(0, 79)}…` : RULE} · /permissions`))).toBe(true);

		await openPanel(ENTER);
		expect(screens[0]).toContain(`✔ bash(rm -rf ${outside()})  [${RULE}]`);
		// The breadcrumb names what was approved; the grant message rides with it.
		expect(reminders.some((r) => r.includes(`<local-command-stdout>Approved bash(rm -rf ${outside()})</local-command-stdout>`))).toBe(true);
		expect(reminders).toContain(`${granted(`bash(rm -rf ${outside()})`)}\n`);
		expect(fake.sentMessages).toHaveLength(0);

		completeMock.mockClear();
		expect(await bash(`rm -rf ${outside()}`)).toBeUndefined();
		expect(completeMock).not.toHaveBeenCalled();
		// Spent: the same call again, and a different one, go to the classifier.
		blockOnce();
		expect((await bash(`rm -rf ${outside()}`))?.block).toBe(true);
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("approving while a turn runs sends the grant to that turn's next request, with no turn started", async () => {
		const emitted: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => void emitted.push(data));
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		ctx.isIdle = () => false;
		await openPanel(ENTER);
		expect(emitted).toContainEqual({ text: granted(`bash(rm -rf ${outside()})`), placement: "user-prepend", orTail: true });
		// The breadcrumb still waits for the next prompt.
		const stdout = emitted.find((data) => (data as { text: string }).text.includes("<local-command-stdout>Approved")) as { placement: string; orTail?: boolean };
		expect(stdout.placement).toBe("user-prepend");
		expect(stdout.orTail).toBeUndefined();
		expect(fake.sentMessages).toHaveLength(0);
	});

	it("keeps an approved denial's grant across /reload, which re-runs the factory, but not into another session", async () => {
		// pi builds a fresh extension instance for every session start.
		const restart = async (reason: string) => {
			fake = createFakePi();
			permissionsExtension(fake.pi as never);
			await fake.fire("session_start", { reason }, ctx);
		};
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel(ENTER);
		await restart("reload");
		completeMock.mockClear();
		expect(await bash(`rm -rf ${outside()}`)).toBeUndefined();
		expect(completeMock).not.toHaveBeenCalled();

		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel(ENTER);
		await restart("fork");
		completeMock.mockClear();
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

	it("tells the model the whole approved command, though the panel clips it", async () => {
		const long = `rm -rf /outside-perm-panel/${"x".repeat(240)}`;
		blockOnce();
		await bash(long);
		await openPanel("r");
		expect(screens[0]).toContain("…");
		expect(fake.sentMessages[0]?.message.content).toBe(granted(`bash(${long})`));
		expect(await bash(long)).toBeUndefined();
	});

	it("starts a turn with the grant message on retry", async () => {
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel("r");
		expect(screens[0]).toContain("(retry)");
		expect(fake.sentMessages).toEqual([
			{
				message: {
					customType: brandedId("permission-retry"),
					content: granted(`bash(rm -rf ${outside()})`),
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
		expect(notices().some((n) => n.includes("denied by auto mode"))).toBe(false);
		// Nothing was denied, so the panel opens on Allow; Recently denied is one tab left, and empty.
		await openPanel(LEFT);
		expect(screens[0]).toContain("No recent denials.");
	});

	it("adds and deletes a rule in the product's project file", async () => {
		// Allow tab (opened first: no denials): Add a new rule…, type, save to the project file.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		const target = productProjectSettingsPath(cwd, home);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);
		expect(reminders.some((r) => r.includes("<local-command-stdout>Added allow rule Bash(npm test:*) to "))).toBe(true);
		// The same rule again is refused, not reported as added.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		expect(screens.join("\n")).toContain("That allow rule is already in ");
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);

		// Rows now: Add a new rule…, Bash(npm test:*).
		await openPanel(DOWN, ENTER, ENTER);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual([]);
		expect(existsSync(productSettingsPath(home))).toBe(false);
	});

	it("opens on Recently denied when something was denied, and lists the ask and deny tabs", async () => {
		blockOnce();
		await bash(`rm -rf ${outside()}`);
		await openPanel(RIGHT, RIGHT, RIGHT);
		expect(screens[0]).toContain(`${brand.name} won't ask before using allowed tools.`);
		expect(screens[1]).toContain(`${brand.name} will always ask for confirmation before using these tools.`);
		expect(screens[2]).toContain(`${brand.name} will always reject requests to use denied tools.`);
	});

	describe("what a denied call asks of the sandbox", () => {
		/** A running sandbox that keeps the host list each run was given (the shell tool's side, `sandboxedCommand`). */
		const runningSandbox = () => {
			const hosts = new Map<string, string[]>();
			const sandbox: ActiveSandbox = {
				wrap: async (command) => `SANDBOX(${command})`,
				annotate: (_id, output) => output,
				allowHosts: (id, list) => void hosts.set(id, [...list]),
				release: (id) => void hosts.delete(id),
				ended: () => {},
				filesystem: () => ({}) as never,
			};
			const settings = { ...SANDBOX_OFF, enabled: true };
			setSandboxForTest(settings, sandbox);
			return hosts;
		};
		const sandboxSupported = process.platform === "darwin" || process.platform === "linux";
		const call = (input: Record<string, unknown>, toolCallId: string) => fake.fireOne<GateResult>("tool_call", { toolName: "bash", input, toolCallId }, ctx);
		const HOSTS = ["a.example", "b.example"];

		it.skipIf(!sandboxSupported)("keys a worktree-wrapped call by the model's command with its sandbox request, so approving the plain call does not cover leaving the sandbox", async () => {
			runningSandbox();
			const worktree = join(home, "wt");
			mkdirSync(worktree, { recursive: true });
			const command = `rm -rf ${outside()}`;
			const wrapped = (toolCallId: string, extra: Record<string, unknown> = {}) => {
				fake.events.emit(ORIGINAL_COMMAND_CHANNEL, { toolCallId, command, cwd: worktree });
				return call({ command: `cd '${worktree}' && (${command}\n)`, ...extra }, toolCallId);
			};
			blockOnce();
			expect((await wrapped("w1"))?.block).toBe(true);
			await openPanel(ENTER);

			completeMock.mockClear();
			blockOnce();
			expect((await wrapped("w2", { dangerouslyDisableSandbox: true }))?.block).toBe(true);
			expect(completeMock).toHaveBeenCalledTimes(2);
			// The grant is still there for the call that was approved.
			completeMock.mockClear();
			expect(await wrapped("w3")).toBeUndefined();
			expect(completeMock).not.toHaveBeenCalled();
		});

		it.skipIf(!sandboxSupported)("shows the hosts a denied call named, and that it asked to leave the sandbox", async () => {
			runningSandbox();
			blockOnce();
			await call({ command: `rm -rf ${outside()}`, allowed_domains: HOSTS }, "h1");
			blockOnce();
			await call({ command: `rm -rf ${outside()}/b`, dangerouslyDisableSandbox: true }, "u1");
			// Newest first: the unsandboxed call, then the one naming hosts; approve both.
			await openPanel(ENTER, DOWN, ENTER);
			expect(screens.at(-1)).toContain(`bash(rm -rf ${outside()}/b) (unsandboxed)`);
			expect(screens.at(-1)).toContain(`bash(rm -rf ${outside()}) [hosts: a.example, b.example]`);
			// The model is told the whole approved call too (the full display).
			const told = reminders.join("\n");
			expect(told).toContain(`bash(rm -rf ${outside()}/b) (unsandboxed)`);
			expect(told).toContain(`bash(rm -rf ${outside()}) [hosts: a.example, b.example]`);
		});

		it.skipIf(!sandboxSupported)("gives an approved call the hosts it named, for its one run", async () => {
			const granted = runningSandbox();
			const command = `rm -rf ${outside()}`;
			blockOnce();
			expect((await call({ command, allowed_domains: HOSTS }, "h1"))?.block).toBe(true);
			await openPanel(ENTER);

			completeMock.mockClear();
			expect(await call({ command, allowed_domains: HOSTS }, "h2")).toBeUndefined();
			expect(completeMock).not.toHaveBeenCalled();
			await sandboxedCommand({ command, original: command, disable: false, cwd, bash: "/bin/bash", id: "h2" });
			expect([...granted.values()]).toEqual([HOSTS]);
		});

		// The panel showed no hosts for a call denied while no sandbox ran, so its approval grants none: once a sandbox
		// runs, the same input would be granted hosts, which is another action, and the retry goes to the classifier.
		const asking = (tool: string): Record<string, unknown> =>
			tool === "bash" ? { command: `rm -rf ${outside()}`, allowed_domains: HOSTS } : { command: `tail -f ${outside()}/log`, description: "watch", allowed_domains: HOSTS };
		it.skipIf(!sandboxSupported).each(["bash", "monitor"])("does not let an approval of a %s call made while no sandbox ran cover it once one runs and would grant it hosts", async (tool) => {
			const input = asking(tool);
			blockOnce();
			expect((await fake.fireOne<GateResult>("tool_call", { toolName: tool, input, toolCallId: "c1" }, ctx))?.block).toBe(true);
			await openPanel(ENTER);
			const approved = screens.at(-1)!.split("\n").find((line) => line.includes("✔"));
			expect(approved).toContain(`${tool}(`);
			expect(approved).not.toContain("[hosts:");

			runningSandbox();
			completeMock.mockClear();
			blockOnce();
			expect((await fake.fireOne<GateResult>("tool_call", { toolName: tool, input, toolCallId: "c2" }, ctx))?.block).toBe(true);
			expect(completeMock).toHaveBeenCalled();
		});
	});

	describe("Auto mode tab", () => {
		const settings = () => JSON.parse(readFileSync(productSettingsPath(home), "utf-8"));

		it("adds a rule to the product's user settings, and the next classifier call is sent it", async () => {
			// Allow → Auto mode is three tabs left; Add a new rule…, Soft deny, type, save.
			await openPanel(LEFT, LEFT, LEFT, ENTER, DOWN, ENTER, ..."Build Cache: deleting ~/.cache/build is fine".split(""), ENTER);
			expect(settings().autoMode.soft_deny).toEqual(["Build Cache: deleting ~/.cache/build is fine"]);
			expect(reminders.some((r) => r.includes("Added auto mode soft deny rule: Build Cache"))).toBe(true);

			blockOnce();
			await bash(`rm -rf ${outside()}`);
			const system = JSON.stringify((completeMock.mock.calls[0][1] as { systemPrompt?: unknown }).systemPrompt);
			expect(system).toContain("Build Cache: deleting ~/.cache/build is fine");
		});

		it("edits and deletes the user's own rules", async () => {
			mkdirSync(productStateDir(), { recursive: true });
			writeFileSync(productSettingsPath(home), JSON.stringify({ autoMode: { allow: ["Mine: my rule"] }, other: 1 }));
			// Rows: add, allow built-ins, Mine, …
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, ENTER, ENTER, "!", ENTER);
			expect(settings().autoMode.allow).toEqual(["Mine: my rule!"]);
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, ENTER, "d", ENTER, "y", ENTER);
			expect(settings()).toEqual({ other: 1 });
		});

		it("keeps $defaults when the environment it extends is edited", async () => {
			mkdirSync(productStateDir(), { recursive: true });
			writeFileSync(productSettingsPath(home), JSON.stringify({ autoMode: { environment: ["$defaults", "- Trusted host: x"] } }));
			let prefilled = "";
			editorReply = (prefill) => {
				prefilled = prefill;
				return `${prefill}\n- Trusted host: y`;
			};
			await openPanel(LEFT, LEFT, LEFT, PAGE_DOWN, PAGE_DOWN, ENTER);
			expect(prefilled).toBe("- Trusted host: x");
			expect(settings().autoMode.environment).toEqual(["$defaults", "- Trusted host: x", "- Trusted host: y"]);
		});

		it("edits the environment through the editor, starting from the built-in default", async () => {
			editorReply = (prefill) => `${prefill}\n- Trusted host: build.internal.example`;
			// Environment is the last row; confirm replacing the default, then the editor runs.
			await openPanel(LEFT, LEFT, LEFT, PAGE_DOWN, PAGE_DOWN, ENTER, ENTER);
			const env = settings().autoMode.environment as string[];
			expect(env).toEqual([...requireText("classifier").defaultEnvironment, "- Trusted host: build.internal.example"]);
			expect(reminders.some((r) => r.includes("Saved your auto mode environment"))).toBe(true);
			// The panel reopened after the editor, on the same tab.
			expect(vi.mocked((ctx.ui as { custom: () => unknown }).custom)).toHaveBeenCalledTimes(2);

			// Saving it empty restores the default.
			editorReply = () => "";
			await openPanel(LEFT, LEFT, LEFT, PAGE_DOWN, PAGE_DOWN, ENTER);
			expect(existsSync(productSettingsPath(home)) ? settings().autoMode?.environment : undefined).toBeUndefined();
		});
	});
});
