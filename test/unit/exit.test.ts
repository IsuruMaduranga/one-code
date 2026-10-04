import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exitExtension from "../../extensions/exit/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let originalExitCode: typeof process.exitCode;
beforeEach(() => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
});
afterEach(() => {
	process.exitCode = originalExitCode;
});

function harness(mode = "print") {
	const fake = createFakePi();
	const ctx = createFakeCtx({ mode });
	exitExtension(fake.pi as never);
	return {
		fake,
		ctx,
		end: (stopReason: string, signal?: AbortSignal) =>
			fake.fire("agent_end", { messages: [{ role: "assistant", stopReason }] }, { ...ctx, signal }),
		settle: () => fake.fire("agent_settled", {}, ctx),
	};
}

describe("one-shot exit status", () => {
	it.each(["print", "json"])("fails a terminal provider error in %s without output or forced shutdown", async (mode) => {
		const { fake, ctx, end, settle } = harness(mode);
		await end("error");
		expect(process.exitCode).toBeUndefined();
		await settle();
		expect(process.exitCode).toBe(1);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		expect(fake.sentMessages).toEqual([]);
		expect(fake.appendedEntries).toEqual([]);
		expect((ctx.ui as { notify: unknown }).notify).not.toHaveBeenCalled();
	});

	it.each(["tui", "rpc"])("does not change the host's exit status in %s", async (mode) => {
		const { end, settle } = harness(mode);
		await end("error");
		await settle();
		expect(process.exitCode).toBeUndefined();
	});

	it.each(["print", "json"])("allows a recovered retry or compaction to succeed in %s", async (mode) => {
		const { end, settle } = harness(mode);
		await end("error");
		await end("stop");
		await settle();
		expect(process.exitCode).toBeUndefined();
	});

	it("uses the final run's outcome, not an earlier success", async () => {
		const { end, settle } = harness();
		await end("stop");
		await end("error");
		await settle();
		expect(process.exitCode).toBe(1);
	});

	it.each([undefined, 0, "0"])("sets an unset or zero exit code (%s) to 1", async (code) => {
		process.exitCode = code;
		const { end, settle } = harness();
		await end("error");
		await settle();
		expect(process.exitCode).toBe(1);
	});

	it.each([2, "7"])("preserves an existing nonzero exit code (%s)", async (code) => {
		process.exitCode = code;
		const { end, settle } = harness();
		await end("error");
		await settle();
		expect(process.exitCode).toBe(Number(code));
	});

	it("does not reset another failure when a run succeeds", async () => {
		const { end, settle } = harness();
		process.exitCode = 2;
		await end("stop");
		await settle();
		expect(process.exitCode).toBe(2);
	});

	it("does not classify a user abort as a provider error", async () => {
		const { end, settle } = harness();
		await end("aborted");
		await settle();
		expect(process.exitCode).toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		await end("error", controller.signal);
		await settle();
		expect(process.exitCode).toBeUndefined();
	});

	it("has no failure to report before a run or on a repeated settle", async () => {
		const { end, settle } = harness();
		await settle();
		expect(process.exitCode).toBeUndefined();
		await end("error");
		await settle();
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		await settle();
		expect(process.exitCode).toBeUndefined();
	});
});

it("still registers /exit as graceful shutdown", async () => {
	const { fake } = harness();
	const shutdown = vi.fn();
	await fake.commands.get("exit")!.handler("", createFakeCtx({ shutdown }));
	expect(shutdown).toHaveBeenCalledOnce();
	expect(process.exitCode).toBeUndefined();
});
