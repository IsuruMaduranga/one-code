/**
 * /permissions with One Code's source provider: Claude Code's settings files
 * are listed read-only, and a rule added, edited or deleted in the panel lands
 * in One Code's own files while Claude Code's stay as they were. The base's
 * permissions-panel-wiring.test.ts covers the panel on the product's own files.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { productProjectSettingsPath } from "../../extensions/lib/product-settings.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "../../test/unit/helpers/fake-pi.ts";
import { stubHome } from "../../test/unit/helpers/home.ts";

const completeMock = vi.mocked(completeSimple);

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";

describe("/permissions and Claude Code's settings files", () => {
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
		stubHome(home);
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

	/** Open the panel, press `pressed`, then Esc; `screens` holds this open's frames only. */
	const openPanel = async (...pressed: string[]) => {
		keys = pressed;
		screens = [];
		await fake.commands.get("permissions")!.handler("", ctx);
	};

	it("adds and deletes a rule in One Code's project file, and leaves Claude Code's files alone", async () => {
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
		// Allow tab (opened first: no denials): Add a new rule…, type, save to the project file.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		const target = productProjectSettingsPath(cwd, home);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);
		expect(reminders.some((r) => r.includes("<local-command-stdout>Added allow rule Bash(npm test:*) to "))).toBe(true);
		// The same rule again is refused, not reported as added.
		await openPanel(ENTER, ..."Bash(npm test:*)".split(""), ENTER, ENTER);
		expect(screens.join("\n")).toContain("That allow rule is already in ");
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual(["Bash(npm test:*)"]);

		// Rows now: Add a new rule…, Bash(npm test:*), Read (read-only).
		await openPanel(DOWN, DOWN, ENTER);
		expect(screens[2]).toContain("One Code does not edit Claude Code user settings.");
		await openPanel(DOWN, ENTER, ENTER);
		expect(JSON.parse(readFileSync(target, "utf-8")).permissions.allow).toEqual([]);
		expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).permissions.allow).toEqual(["Read"]);
		expect(existsSync(join(home, ".onecode", "settings.json"))).toBe(false);
	});

	describe("Auto mode tab", () => {
		const settings = () => JSON.parse(readFileSync(join(home, ".onecode", "settings.json"), "utf-8"));

		it("edits and deletes One Code's rules, and leaves Claude Code's read-only", async () => {
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: ["$defaults", "CC Rule: from Claude Code"] } }));
			mkdirSync(join(home, ".onecode"), { recursive: true });
			writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify({ autoMode: { allow: ["Mine: my rule"] }, other: 1 }));
			// Rows: add, allow built-ins, CC Rule (read-only), Mine, …
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, ENTER);
			expect(screens[5]).toContain("One Code does not edit Claude Code user settings.");
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, DOWN, ENTER, ENTER, "!", ENTER);
			expect(settings().autoMode.allow).toEqual(["Mine: my rule!"]);
			await openPanel(LEFT, LEFT, LEFT, DOWN, DOWN, DOWN, ENTER, "d", ENTER, "y", ENTER);
			expect(settings()).toEqual({ other: 1 });
			expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).autoMode.allow).toEqual(["$defaults", "CC Rule: from Claude Code"]);
		});
	});
});
