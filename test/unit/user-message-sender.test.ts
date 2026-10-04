import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserMessageSender } from "../../extensions/lib/notifications.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

afterEach(() => vi.useRealTimers());

describe("createUserMessageSender", () => {
	it.each(["print", "json"] as const)("waits through idle preflight and the whole run in %s", async (mode) => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const send = createUserMessageSender(fake.pi as never);
		let active = false;
		let settle!: () => void;
		const idle = new Promise<void>((resolve) => { settle = resolve; });
		const waitForIdle = vi.fn(() => active ? idle : Promise.resolve());
		let returned = false;
		const running = send({ mode, isIdle: () => !active, waitForIdle }, "prompt").then(() => { returned = true; });
		await vi.advanceTimersByTimeAsync(500);
		await fake.fire("before_agent_start", {});
		expect(returned).toBe(false);
		expect(waitForIdle).not.toHaveBeenCalled();
		active = true;
		await fake.fire("agent_start", {});
		expect(waitForIdle).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000); // The startup timeout must not cap the model/tool run.
		expect(returned).toBe(false);
		settle();
		await running;
		expect(returned).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("arms before sending and handles a turn already settled by the wait", async () => {
		const fake = createFakePi();
		fake.pi.sendUserMessage = () => { void fake.fire("agent_start", {}); };
		const send = createUserMessageSender(fake.pi as never);
		const waitForIdle = vi.fn(async () => {});
		await send({ mode: "json", isIdle: () => true, waitForIdle }, "prompt");
		expect(waitForIdle).toHaveBeenCalledTimes(1);
	});

	it.each(["tui", "rpc"] as const)("does not wait or hold a timer in %s", async (mode) => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const send = createUserMessageSender(fake.pi as never);
		const isIdle = vi.fn(() => true);
		const waitForIdle = vi.fn(async () => {});
		await send({ mode, isIdle, waitForIdle }, "prompt", { deliverAs: "followUp" });
		expect(fake.sentUserMessages).toEqual([{ content: "prompt", options: { deliverAs: "followUp" } }]);
		expect(isIdle).not.toHaveBeenCalled();
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds a preflight failure or consumed input, clears timers, and can send again", async () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const send = createUserMessageSender(fake.pi as never);
		const ctx = { mode: "json" as const, isIdle: () => true, waitForIdle: vi.fn(async () => {}) };
		const failed = expect(send(ctx, "consumed")).rejects.toThrow("Check model authentication and extension input hooks");
		await vi.advanceTimersByTimeAsync(30_000);
		await failed;
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		const running = send(ctx, "next prompt");
		await fake.fire("agent_start", {});
		await running;
		expect(ctx.waitForIdle).toHaveBeenCalledTimes(1);
		expect(fake.handlers.get("agent_start")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects shutdown during preflight without using the stale context", async () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const send = createUserMessageSender(fake.pi as never);
		const waitForIdle = vi.fn(async () => {});
		const failed = expect(send({ mode: "print", isIdle: () => true, waitForIdle }, "prompt")).rejects.toThrow("Session shut down");
		await fake.fire("session_shutdown", {});
		await failed;
		await fake.fire("agent_start", {});
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up if sending throws synchronously", async () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		fake.pi.sendUserMessage = () => { throw new Error("send failed"); };
		const send = createUserMessageSender(fake.pi as never);
		await expect(send({ mode: "json", isIdle: () => true }, "prompt")).rejects.toThrow("send failed");
		expect(vi.getTimerCount()).toBe(0);
	});
});
