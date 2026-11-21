/**
 * agents/subagents/stall-watch.ts and runner.ts stallWatchExtension: a
 * subagent turn with no progress for ten minutes fails, as Claude Code's
 * async-agent stall watchdog does (findings §94): every streamed chunk counts
 * as progress, a running tool pauses it. The reason reaches the run's tracker
 * the way a guard's does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stallWatchExtension, turnFailureExtension } from "../../extensions/agents/subagents/runner.ts";
import { SessionTurnTracker } from "../../extensions/agents/subagents/session-turns.ts";
import { AGENT_STALL_MS, agentStallMs, StallWatch } from "../../extensions/agents/subagents/stall-watch.ts";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const watch = () => {
	const stalls: number[] = [];
	return { stalls, watch: new StallWatch((seconds) => stalls.push(seconds)) };
};

describe("StallWatch", () => {
	it("fails a turn that streams nothing for ten minutes, once", () => {
		const { stalls, watch: w } = watch();
		w.turnStarted();
		vi.advanceTimersByTime(AGENT_STALL_MS - 1);
		expect(stalls).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(stalls).toEqual([600]);
		w.progress();
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([600]);
	});

	it("counts every streamed chunk as progress, but only during a turn", () => {
		const { stalls, watch: w } = watch();
		w.progress();
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([]);
		w.turnStarted();
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(AGENT_STALL_MS - 1000);
			w.progress();
		}
		expect(stalls).toEqual([]);
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600]);
	});

	it("pauses while a tool runs or the session compacts, and counts again after", () => {
		const { stalls, watch: w } = watch();
		w.turnStarted();
		w.toolStarted();
		w.toolStarted();
		vi.advanceTimersByTime(AGENT_STALL_MS * 3);
		w.toolEnded();
		vi.advanceTimersByTime(AGENT_STALL_MS * 3);
		expect(stalls).toEqual([]);
		w.toolEnded();
		w.compactionStarted();
		vi.advanceTimersByTime(AGENT_STALL_MS * 3);
		expect(stalls).toEqual([]);
		w.compactionEnded();
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600]);
	});

	it("ends a compaction pause at the next reply, so a compaction that never reports its end cannot hide a stall", () => {
		const { stalls, watch: w } = watch();
		w.turnStarted();
		w.compactionStarted();
		w.replyStarted();
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600]);
	});

	it("does not restart the clock when pi starts the turn or a reply again, so silent retries add up", () => {
		const { stalls, watch: w } = watch();
		w.turnStarted();
		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(AGENT_STALL_MS / 4);
			// A retry: pi's next attempt starts after the last one failed in silence.
			w.turnStarted();
			w.replyStarted();
		}
		expect(stalls).toEqual([]);
		vi.advanceTimersByTime(AGENT_STALL_MS / 4);
		expect(stalls).toEqual([600]);
	});

	it("stops when the turn settles, and watches the next turn afresh", () => {
		const { stalls, watch: w } = watch();
		w.turnStarted();
		w.stop();
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		w.progress();
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([]);
		w.turnStarted();
		vi.advanceTimersByTime(AGENT_STALL_MS);
		w.stop();
		w.turnStarted();
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600, 600]);
	});
});

describe("agentStallMs", () => {
	it("is pi's HTTP idle timeout plus five minutes, none when that timeout is off, and the knob when set", () => {
		expect(agentStallMs(undefined, 300_000)).toBe(600_000);
		expect(agentStallMs(undefined, 900_000)).toBe(1_200_000);
		expect(agentStallMs(undefined, 0)).toBeUndefined();
		expect(agentStallMs("120000", 300_000)).toBe(120_000);
		expect(agentStallMs("0", 300_000)).toBeUndefined();
		expect(agentStallMs("soon", 300_000)).toBe(600_000);
		expect(agentStallMs("", 300_000)).toBe(600_000);
	});
});

describe("stallWatchExtension in a child session", () => {
	/** A child's bus with the stall watch and the guard path that carries its reason to the run's tracker. */
	function child() {
		const fake = createFakePi();
		const tracker = new SessionTurnTracker();
		turnFailureExtension(tracker)(fake.pi as never);
		stallWatchExtension(AGENT_STALL_MS)(fake.pi as never);
		const ctx = { abort: vi.fn() };
		const fire = (event: string) => fake.fire(event, { type: event }, ctx);
		return { tracker, ctx, fire };
	}

	it("stops a silent turn after ten minutes with Claude Code's reason, which the tracker reports", async () => {
		const { tracker, ctx, fire } = child();
		await fire("agent_start");
		await fire("message_start");
		await vi.advanceTimersByTimeAsync(AGENT_STALL_MS - 1000);
		expect(ctx.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(ctx.abort).toHaveBeenCalledOnce();
		expect(tracker.harnessStop).toBe(subagentResultText().stalled({ seconds: 600 }));
		expect(tracker.turnOutcome().failureReason).toBe("Agent stalled: no progress for 600s (stream watchdog did not recover)");
	});

	it("does not count a reply that ended, so a retry that failed in silence leaves the clock running", async () => {
		const { ctx, fire } = child();
		await fire("agent_start");
		await vi.advanceTimersByTimeAsync(AGENT_STALL_MS / 2);
		await fire("message_start");
		await fire("message_end");
		await vi.advanceTimersByTimeAsync(AGENT_STALL_MS / 2);
		expect(ctx.abort).toHaveBeenCalledOnce();
	});

	it("keeps a turn alive on raw provider events, and lets a running tool take as long as it needs", async () => {
		const { ctx, fire } = child();
		await fire("agent_start");
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(AGENT_STALL_MS - 1000);
			await fire("provider_stream_event");
		}
		await fire("tool_execution_start");
		await vi.advanceTimersByTimeAsync(AGENT_STALL_MS * 3);
		await fire("tool_execution_end");
		await fire("agent_settled");
		await vi.advanceTimersByTimeAsync(AGENT_STALL_MS * 3);
		expect(ctx.abort).not.toHaveBeenCalled();
	});
});
