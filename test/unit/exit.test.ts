import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exitExtension from "../../extensions/exit/index.ts";
import initExtension from "../../extensions/init/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let originalExitCode: typeof process.exitCode;
beforeEach(() => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
});
afterEach(() => {
	process.exitCode = originalExitCode;
	vi.useRealTimers();
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
		shutdown: (reason = "quit") => fake.fire("session_shutdown", { reason }, ctx),
	};
}

describe("one-shot exit status", () => {
	it.each(["print", "json"])("fails a terminal provider error in %s without output or forced shutdown", async (mode) => {
		const { fake, ctx, end, settle, shutdown } = harness(mode);
		await end("error");
		expect(process.exitCode).toBeUndefined();
		await settle();
		// runPrintMode can still submit another prompt or replace the session.
		expect(process.exitCode).toBeUndefined();
		await shutdown();
		expect(process.exitCode).toBe(1);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		expect(fake.sentMessages).toEqual([]);
		expect(fake.appendedEntries).toEqual([]);
		expect((ctx.ui as { notify: unknown }).notify).not.toHaveBeenCalled();
	});

	it.each(["tui", "rpc"])("does not change the host's exit status in %s", async (mode) => {
		const { end, settle, shutdown } = harness(mode);
		await end("error");
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it.each(["print", "json"])("allows a recovered retry or compaction to succeed in %s", async (mode) => {
		const { end, settle, shutdown } = harness(mode);
		await end("error");
		await end("stop");
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it("uses the final run's outcome, not an earlier success", async () => {
		const { end, settle, shutdown } = harness();
		await end("stop");
		await end("error");
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(1);
	});

	it.each([undefined, 0, "0"])("sets an unset or zero exit code (%s) to 1", async (code) => {
		process.exitCode = code;
		const { end, settle, shutdown } = harness();
		await end("error");
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(1);
	});

	it.each([1, 2, "7"])("preserves an existing nonzero exit code (%s)", async (code) => {
		process.exitCode = code;
		const { end, settle, shutdown } = harness();
		await end("error");
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(Number(code));
	});

	it.each(["print", "json"])("does not retain an earlier failure when a later prompt succeeds in %s", async (mode) => {
		const { end, settle, shutdown } = harness(mode);
		await end("error");
		await settle();
		await end("stop");
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it("does not retain an earlier failure when the final prompt is aborted", async () => {
		const { end, settle, shutdown } = harness("json");
		await end("error");
		await settle();
		await end("aborted");
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it.each([1, 2])("does not clear a pre-existing failure (%s) after error then success", async (code) => {
		const { end, settle, shutdown } = harness();
		process.exitCode = code;
		await end("error");
		await settle();
		await end("stop");
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(code);
	});

	it("does not clear a failure set by another component between prompts", async () => {
		const { end, settle, shutdown } = harness();
		await end("error");
		await settle();
		process.exitCode = 1;
		await end("stop");
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(1);
	});

	it.each(["new", "resume", "fork", "reload"])("does not leak an error into the replacement session on %s", async (reason) => {
		const old = harness("json");
		await old.end("error");
		await old.settle();
		await old.shutdown(reason);
		const next = harness("json");
		await next.end("stop");
		await next.settle();
		await next.shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it("does not reset another failure when a run succeeds", async () => {
		const { end, settle, shutdown } = harness();
		process.exitCode = 2;
		await end("stop");
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(2);
	});

	it.each([false, true])("does not classify a user abort as a provider error (mislabelled: %s)", async (mislabelled) => {
		const { end, settle, shutdown } = harness();
		const controller = new AbortController();
		controller.abort();
		await end(mislabelled ? "error" : "aborted", controller.signal);
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it("does not mistake a tool error for a provider error", async () => {
		const { fake, ctx, settle, shutdown } = harness();
		await fake.fire("agent_end", { messages: [
			{ role: "assistant", stopReason: "toolUse" },
			{ role: "toolResult", isError: true },
		] }, ctx);
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it.each(["print", "json"])("fails /init when preflight never starts a run in %s", async (mode) => {
		vi.useFakeTimers();
		const { fake, ctx, shutdown } = harness(mode);
		initExtension(fake.pi as never);
		// pi catches command-handler errors and only logs them; no agent_end
		// or agent_settled fires when sendUserMessage fails during preflight.
		const logged: string[] = [];
		const command = fake.commands.get("init")!.handler("", ctx).catch((error: Error) => { logged.push(error.message); });
		await vi.advanceTimersByTimeAsync(30_000);
		await command;
		expect(logged).toEqual([expect.stringContaining("Check model authentication")]);
		await shutdown();
		expect(process.exitCode).toBe(1);
	});

	it("lets a later successful prompt replace a command-start failure", async () => {
		vi.useFakeTimers();
		const { fake, ctx, end, settle, shutdown } = harness("json");
		initExtension(fake.pi as never);
		const command = fake.commands.get("init")!.handler("", ctx).catch(() => {});
		await vi.advanceTimersByTimeAsync(30_000);
		await command;
		await end("stop");
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it("has no failure to report before a run", async () => {
		const { settle, shutdown } = harness();
		await settle();
		await shutdown();
		expect(process.exitCode).toBeUndefined();
	});

	it("does not lose the last actual outcome on an empty settle", async () => {
		const { end, settle, shutdown } = harness();
		await end("error");
		await settle();
		await settle();
		await shutdown();
		expect(process.exitCode).toBe(1);
	});
});

it("still registers /exit as graceful shutdown", async () => {
	const { fake } = harness();
	const shutdown = vi.fn();
	await fake.commands.get("exit")!.handler("", createFakeCtx({ shutdown }));
	expect(shutdown).toHaveBeenCalledOnce();
	expect(process.exitCode).toBeUndefined();
});
