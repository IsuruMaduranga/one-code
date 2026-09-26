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
import { forwardSlashes } from "../../extensions/lib/paths.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

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
		vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
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
			modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
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
	const outside = () => forwardSlashes(join(home, "elsewhere"));

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
		expect(notices().some((n) => n.includes("denied by auto mode"))).toBe(false);
		// Nothing was denied, so the panel opens on Allow; Recently denied is one tab left, and empty.
		await openPanel(LEFT);
		expect(screens[0]).toContain("No recent denials.");
	});

	it("adds and deletes a rule in One Code's project file, and leaves Claude Code's files alone", async () => {
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
		// Allow tab (opened first: no denials): Add a new rule…, type, save to the project file.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		const target = oneCodeProjectSettingsPath(cwd, home);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);
		expect(reminders.some((r) => r.includes("<local-command-stdout>Added allow rule Bash(npm test:*) to "))).toBe(true);
		// The same rule again is refused, not reported as added.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		expect(screens.join("\n")).toContain("That allow rule is already in ");
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);

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

	describe("Auto mode tab", () => {
		const settings = () => JSON.parse(readFileSync(join(home, ".onecode", "settings.json"), "utf-8"));

		it("adds a rule to One Code's user settings, and the next classifier call is sent it", async () => {
			// Allow → Auto mode is three tabs left; Add a new rule…, Soft deny, type, save.
			await openPanel(LEFT, LEFT, LEFT, ENTER, DOWN, ENTER, ..."Build Cache: deleting ~/.cache/build is fine".split(""), ENTER);
			expect(settings().autoMode.soft_deny).toEqual(["Build Cache: deleting ~/.cache/build is fine"]);
			expect(reminders.some((r) => r.includes("Added auto mode soft deny rule: Build Cache"))).toBe(true);

			blockOnce();
			await bash(`rm -rf ${outside()}`);
			const system = JSON.stringify((completeMock.mock.calls[0][1] as { systemPrompt?: unknown }).systemPrompt);
			expect(system).toContain("Build Cache: deleting ~/.cache/build is fine");
		});

		it("edits and deletes One Code's rules, and leaves Claude Code's read-only", async () => {
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: ["$defaults", "CC Rule: from Claude Code"] } }));
			mkdirSync(join(home, ".onecode"), { recursive: true });
			writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify({ autoMode: { allow: ["Mine: my rule"] }, other: 1 }));
			// Rows: add, allow built-ins, CC Rule (read-only), Mine, …
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, ENTER);
			expect(screens[5]).toContain("One Code does not edit Claude Code's files.");
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, DOWN, ENTER, ENTER, "!", ENTER);
			expect(settings().autoMode.allow).toEqual(["Mine: my rule!"]);
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, DOWN, ENTER, "d", ENTER, "y", ENTER);
			expect(settings()).toEqual({ other: 1 });
			expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).autoMode.allow).toEqual(["$defaults", "CC Rule: from Claude Code"]);
		});

		it("keeps $defaults when the environment it extends is edited", async () => {
			mkdirSync(join(home, ".onecode"), { recursive: true });
			writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify({ autoMode: { environment: ["$defaults", "- Trusted host: x"] } }));
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
			expect(env.at(-1)).toBe("- Trusted host: build.internal.example");
			expect(env.length).toBeGreaterThan(10);
			expect(reminders.some((r) => r.includes("Saved your auto mode environment"))).toBe(true);
			// The panel reopened after the editor, on the same tab.
			expect(vi.mocked((ctx.ui as { custom: () => unknown }).custom)).toHaveBeenCalledTimes(2);

			// Saving it empty restores the default.
			editorReply = () => "";
			await openPanel(LEFT, LEFT, LEFT, PAGE_DOWN, PAGE_DOWN, ENTER);
			expect(existsSync(join(home, ".onecode", "settings.json")) ? settings().autoMode?.environment : undefined).toBeUndefined();
		});
	});
});
