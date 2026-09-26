import { afterEach, describe, expect, it } from "vitest";
import { type BackgroundTask, TASK_REGISTER_CHANNEL } from "../../extensions/background/registry.ts";
import bashExtension from "../../extensions/bash/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/**
 * A detached background shell has no deadline, whatever `timeout` the model
 * sends (Claude Code clears the timer when a command goes to the background).
 * The one-shot path, which blocks the turn, still honours it.
 */
describe("bash run_in_background and timeout", { timeout: 20_000 }, () => {
	const started: BackgroundTask[] = [];
	afterEach(async () => {
		for (const task of started.splice(0)) {
			task.stop();
			await task.finished;
		}
	});

	function setup() {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		fake.events.on(TASK_REGISTER_CHANNEL, (task) => started.push(task as BackgroundTask));
		const bash = fake.tools.get("bash");
		if (!bash) throw new Error("bash tool not registered");
		return bash;
	}

	it("keeps a detached task running past the model's timeout", async () => {
		const bash = setup();
		const ctx = createFakeCtx({ mode: "tui", hasUI: true });
		await bash.execute("call-1", { command: "sleep 10", run_in_background: true, timeout: 300 }, undefined, undefined, ctx);
		expect(started).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(started[0]?.status).toBe("running");
	});

	it("still times out a one-shot background run, which holds the turn", async () => {
		const bash = setup();
		const ctx = createFakeCtx({ mode: "print" });
		const result = (await bash.execute("call-2", { command: "sleep 10", run_in_background: true, timeout: 500 }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(started).toHaveLength(0);
		expect(result.content[0]?.text).toContain("timed out after 0.5s");
	});
});
