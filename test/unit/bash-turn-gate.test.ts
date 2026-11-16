/**
 * A `!` run starts a turn only in the bundled app's terminal. Under a plain pi
 * install the bash feature's `user_bash` handler returns nothing, so another
 * extension's handler or pi's own path runs the command; an RPC client's
 * `bash` command and a print or JSON run get the app's operations unwrapped
 * (lib/shell-run/user-bash-turn.ts `turnAfterBashAllowed`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLauncherEnv, LAUNCHER_ENV_VAR, LAUNCHER_VARS } from "../../extensions/lib/app/app-launch.mjs";
import { BASH_TURN_MESSAGE, turnAfterBashAllowed, USER_BASH_CHANNEL } from "../../extensions/lib/shell-run/user-bash-turn.ts";
import bashTurnExtension from "../../extensions/tools/bash-turn/index.ts";
import bashExtension from "../../extensions/tools/bash/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const home = "/home/tester";
const event = { type: "user_bash", command: "true", excludeFromContext: false, cwd: process.cwd() };

/** The bash and bash-turn features on one fake pi, in an idle session; `asked` counts the requests the handler emitted. */
async function session() {
	const fake = createFakePi();
	bashExtension(fake.pi as never);
	bashTurnExtension(fake.pi as never);
	await fake.fire("session_start", {}, createFakeCtx({ isIdle: () => true }));
	let asked = 0;
	fake.events.on(USER_BASH_CHANNEL, () => asked++);
	/** Fire `user_bash` from `mode`, run the returned operations, and report what came back and whether a turn started. */
	const bang = async (mode: string) => {
		const result = await fake.fireOne<{ operations?: { exec: (c: string, cwd: string, o: { onData: () => void }) => Promise<unknown> } }>("user_bash", event, createFakeCtx({ mode, isIdle: () => true }));
		if (result?.operations) await result.operations.exec("true", process.cwd(), { onData: () => {} });
		await new Promise((resolve) => setImmediate(resolve));
		const turns = fake.sentMessages.filter((sent) => sent.message.customType === BASH_TURN_MESSAGE).length;
		fake.sentMessages.length = 0;
		return { result, turns };
	};
	return { bang, asked: () => asked };
}

describe("turnAfterBashAllowed", () => {
	it("allows a turn only under the app, from its terminal", () => {
		expect(turnAfterBashAllowed({ app: true, mode: "tui" })).toBe(true);
		for (const mode of ["rpc", "json", "print"]) expect(turnAfterBashAllowed({ app: true, mode })).toBe(false);
		expect(turnAfterBashAllowed({ app: false, mode: "tui" })).toBe(false);
	});
});

describe("the bash feature's user_bash handler", { timeout: 20_000 }, () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	const launchApp = () => {
		for (const name of [...LAUNCHER_VARS, LAUNCHER_ENV_VAR]) vi.stubEnv(name, undefined);
		applyLauncherEnv(process.env, { home, appVersion: "0.4.2", installMethod: "npm" });
	};

	it("under the app, in its terminal: returns the app's operations, wrapped, and the run starts a turn", async () => {
		launchApp();
		const { bang, asked } = await session();
		const { result, turns } = await bang("tui");
		expect(result?.operations).toBeDefined();
		expect(turns).toBe(1);
		expect(asked()).toBe(1);
	});

	it("under a plain pi install: returns nothing and asks nothing, so later handlers and pi's own path run the command", async () => {
		for (const name of [...LAUNCHER_VARS, LAUNCHER_ENV_VAR]) vi.stubEnv(name, undefined);
		const { bang, asked } = await session();
		for (const mode of ["tui", "rpc", "json", "print"]) {
			const { result, turns } = await bang(mode);
			expect(result).toBeUndefined();
			expect(turns).toBe(0);
		}
		expect(asked()).toBe(0);
	});

	it("under the app, from an RPC client's bash command or a print or JSON run: the app's operations as before, and no turn", async () => {
		launchApp();
		const { bang, asked } = await session();
		for (const mode of ["rpc", "json", "print"]) {
			const { result, turns } = await bang(mode);
			expect(result?.operations).toBeDefined();
			expect(turns).toBe(0);
		}
		expect(asked()).toBe(0);
	});
});
