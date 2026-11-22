/**
 * The permission gate through its dialog in the TUI (safety/permissions/index.ts
 * with lib/ui/permission-dialog.ts): the dialog shows the call and returns
 * the same option the select did, so the grant, the "tell the agent what to
 * do" follow-up and Esc's stop behave as before; RPC keeps the select.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userDenialText } from "../../extensions/lib/consent/user-denial.ts";
import { brand, envName } from "../../extensions/lib/profile/brand.mjs";
import { MODE_CHANNEL } from "../../extensions/lib/rules/plan-mode-channels.ts";
import permissionsExtension from "../../extensions/safety/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type GateResult = { block?: boolean; reason?: string; terminate?: boolean } | undefined;

describe("the permission dialog in the gate", () => {
	let fake: FakePi;
	let stateDir: string;
	let cwd: string;
	let ctx: Record<string, unknown>;
	/** Keys the next dialogs receive, one list per dialog. */
	let keys: string[][];
	const screens: string[][] = [];

	const makeCtx = (mode: string) =>
		createFakeCtx({
			cwd,
			hasUI: true,
			mode,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(stateDir, "session"), getBranch: () => [] },
			ui: {
				select: vi.fn(async (_title: string, options: string[]) => options[0]),
				input: vi.fn(async () => undefined),
				custom: vi.fn(
					(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) =>
						new Promise((resolve) => {
							const component = factory({ requestRender: () => {} }, {}, undefined, resolve);
							screens.push(component.render(80));
							for (const key of keys.shift() ?? []) component.handleInput(key);
						}),
				),
			},
		});
	const call = (toolName: string, input: Record<string, unknown>, toolCallId = `c-${Math.random()}`) => fake.fireOne<GateResult>("tool_call", { toolName, input, toolCallId }, ctx);
	const ui = () => ctx.ui as Record<string, ReturnType<typeof vi.fn>>;

	beforeEach(async () => {
		stateDir = mkdtempSync(join(tmpdir(), "perm-dialog-"));
		cwd = join(stateDir, "project");
		vi.stubEnv(envName("STATE_DIR"), join(stateDir, brand.stateDir));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(stateDir, "agent"));
		fake = createFakePi();
		keys = [];
		screens.length = 0;
		permissionsExtension(fake.pi as never);
		ctx = makeCtx("interactive");
		await fake.fire("session_start", { reason: "startup" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("shows a Bash call with its description and allows it on 1", async () => {
		keys = [["1"]];
		expect(await call("bash", { command: "rm -rf build", description: "Remove the build folder" })).toBeUndefined();
		expect(ui().select).not.toHaveBeenCalled();
		const text = screens[0].join("\n");
		expect(text).toContain(" Bash command\n\n   rm -rf build\n   Remove the build folder\n");
		expect(text).toContain(" Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for this exact command this session\n   3. No, tell the agent what to do differently");
	});

	it("grants the session option picked with arrows and Enter, so the next call does not ask", async () => {
		keys = [["\x1b[B", "\r"]];
		expect(await call("write", { path: "a.txt", content: "x" })).toBeUndefined();
		expect(screens[0][1]).toBe(" Write");
		expect(await call("write", { path: "b.txt", content: "y" })).toBeUndefined();
		expect(screens).toHaveLength(1);
	});

	it("asks for a reason after No, and stops the turn on Esc without one", async () => {
		keys = [["3"]];
		ui().input.mockImplementationOnce(async () => "use make clean");
		const no = await call("bash", { command: "rm -rf build" });
		expect(no?.reason).toContain("use make clean");
		expect(no?.terminate).toBe(false);

		keys = [["\x1b"]];
		const esc = await call("bash", { command: "rm -rf dist" });
		expect(esc).toMatchObject({ block: true, reason: userDenialText(), terminate: true });
		expect(ui().input).toHaveBeenCalledTimes(1);
	});

	it("keeps the select, with its title unchanged, in RPC", async () => {
		ctx = makeCtx("rpc");
		await fake.fire("session_start", { reason: "startup" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
		expect(await call("bash", { command: "rm -rf build" })).toBeUndefined();
		expect(ui().custom).not.toHaveBeenCalled();
		expect(ui().select).toHaveBeenCalledWith("Allow bash?\n\n  rm -rf build", ["Yes", "Yes, and don't ask again for this exact command this session", "No, tell the agent what to do differently"], expect.anything());
	});
});
