/**
 * lib/shell-tool.ts: the default `timeout` both shell descriptions promise
 * (Claude Code's 120000 ms). pi's executor applies none, so a foreground
 * command without `timeout` ran until Esc, and a one-shot `run_in_background`
 * (which blocks the run) hung it forever. A detached background shell keeps
 * having no deadline (findings §31; bash-background-timeout.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";

const blocking = vi.hoisted(() => ({ calls: [] as Array<{ timeoutSeconds?: number }>, timedOut: false }));
vi.mock("../../extensions/bash/background.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/bash/background.ts")>();
	return {
		...actual,
		runBackgroundBashBlocking: async (options: { timeoutSeconds?: number }) => {
			blocking.calls.push(options);
			return { exitCode: null, signal: "SIGTERM", stopped: false, timedOut: blocking.timedOut, output: "listening on :3000\n" };
		},
	};
});

import { DEFAULT_TIMEOUT_MS, registerShellTool } from "../../extensions/lib/shell-tool.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

function mount() {
	const fake = createFakePi();
	const foreground = vi.fn(async (..._args: unknown[]) => ({ content: [{ type: "text", text: "ok" }], details: {} }));
	registerShellTool(fake.pi as never, {
		name: "bash",
		ccLabel: "Bash",
		description: "",
		parameters: Type.Object({ command: Type.String() }),
		base: { label: "Bash" },
		foreground: () => ({ execute: foreground }),
		guard: () => undefined,
		backgroundShell: () => ({ shell: "/bin/bash", args: ["-c"] }) as never,
	});
	return { tool: fake.tools.get("bash")!, foreground };
}

describe("shell tools: the default timeout (A6-M3, A3-M3)", () => {
	beforeEach(() => {
		blocking.calls.length = 0;
		blocking.timedOut = false;
	});

	it("gives a foreground command without `timeout` Claude Code's 120000 ms default, in seconds for pi", async () => {
		const { tool, foreground } = mount();
		await tool.execute("c1", { command: "npm run dev" }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
		expect(foreground.mock.calls[0][1]).toEqual({ command: "npm run dev", timeout: 120 });
	});

	it("keeps the model's own timeout, clamped at 600000 ms", async () => {
		const { tool, foreground } = mount();
		const ctx = createFakeCtx({ mode: "tui" });
		await tool.execute("c1", { command: "make", timeout: 5_000 }, undefined, undefined, ctx);
		await tool.execute("c2", { command: "make", timeout: 9_000_000 }, undefined, undefined, ctx);
		expect(foreground.mock.calls.map((call) => (call[1] as { timeout: number }).timeout)).toEqual([5, 600]);
	});

	it("holds a one-shot background run to the default and says plainly why it stopped", async () => {
		blocking.timedOut = true;
		const { tool } = mount();
		const result = (await tool.execute("c1", { command: "npm run dev", run_in_background: true }, undefined, undefined, createFakeCtx({ mode: "print" }))) as {
			content: Array<{ text: string }>;
		};
		expect(blocking.calls[0].timeoutSeconds).toBe(120);
		const text = result.content[0].text;
		expect(text).toContain("failed (timed out after 120s)");
		expect(text).toContain("It was stopped at the default 120000 ms timeout (no `timeout` was given)");
		expect(text).toContain("a one-shot session cannot keep a background command running after the run ends");
		expect(text).toContain("listening on :3000");
	});

	it("names the model's own timeout when that is what stopped a one-shot run, and adds nothing when it finished", async () => {
		blocking.timedOut = true;
		const { tool } = mount();
		const ctx = createFakeCtx({ mode: "json" });
		const stopped = (await tool.execute("c1", { command: "sleep 99", run_in_background: true, timeout: 3_000 }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(stopped.content[0].text).toContain("It was stopped at its 3000 ms timeout:");
		blocking.timedOut = false;
		const finished = (await tool.execute("c2", { command: "true", run_in_background: true }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(finished.content[0].text).not.toContain("It was stopped at");
	});
});
