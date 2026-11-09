/**
 * `/init` submits the profile's prompt for the project's instruction file as
 * a user turn, and waits for that turn only in the one-shot modes. One Code's
 * prompt itself: profile/test/profile-init-text.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import initExtension from "../../extensions/init/index.ts";
import { instructionTargets } from "../../extensions/lib/instructions.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import { commandDisplayLine, promptCommandText } from "../../extensions/lib/plugins/skill-invoke.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { captureUserTurns } from "./helpers/user-turn.ts";

describe("/init prompt", () => {
	it.each(["print", "json"])("waits for the triggered turn in %s mode", async (mode) => {
		const fake = createFakePi();
		const startTurn = captureUserTurns(fake);
		initExtension(fake.pi as never);
		let settle!: () => void;
		const idle = new Promise<void>((resolve) => { settle = resolve; });
		let active = false;
		// pi reports idle throughout asynchronous prompt preflight.
		const waitForIdle = vi.fn(() => active ? idle : Promise.resolve());
		let returned = false;
		const run = fake.commands.get("init")!.handler("", createFakeCtx({ mode, waitForIdle })).then(() => { returned = true; });
		try {
			await vi.waitFor(() => expect(fake.sentUserMessages).toHaveLength(1));
			await fake.fire("before_agent_start", {});
			expect(returned).toBe(false);
			expect(waitForIdle).not.toHaveBeenCalled();
			active = true;
			await startTurn();
			await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledTimes(1));
			expect(returned).toBe(false);
		} finally {
			settle();
			await run;
		}
		expect(returned).toBe(true);
	});

	it.each(["tui", "rpc"])("does not wait for the triggered turn in %s mode", async (mode) => {
		const fake = createFakePi();
		initExtension(fake.pi as never);
		const waitForIdle = vi.fn(async () => {});
		await fake.commands.get("init")!.handler("", createFakeCtx({ mode, waitForIdle }));
		expect(fake.sentUserMessages).toHaveLength(1);
		expect(waitForIdle).not.toHaveBeenCalled();
	});

	it("submits it as a user turn led by the command breadcrumb, shown as /init", async () => {
		const fake = createFakePi();
		initExtension(fake.pi as never);
		await fake.commands.get("init")!.handler("", createFakeCtx({ mode: "tui" }));
		const content = promptCommandText("init", "", requireText("init").prompt(instructionTargets().project));
		expect(fake.sentUserMessages).toEqual([{ content, options: { deliverAs: "followUp" } }]);
		expect(commandDisplayLine(content)).toBe("/init");
	});
});
