/**
 * agents/subagents/stall-watch.ts: a subagent turn with no progress for ten
 * minutes fails, as Claude Code's async-agent stall watchdog does (findings
 * §94): every streamed chunk counts as progress, a running tool pauses it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamProgressExtension, SubagentRuntime } from "../../extensions/agents/subagents/runner.ts";
import { SessionTurnTracker } from "../../extensions/agents/subagents/session-turns.ts";
import { AGENT_STALL_MS, StallWatch } from "../../extensions/agents/subagents/stall-watch.ts";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const watch = () => {
	const stalls: number[] = [];
	return { stalls, watch: new StallWatch((seconds) => stalls.push(seconds)) };
};

describe("StallWatch", () => {
	it("fails a turn that streams nothing for ten minutes, once", () => {
		const { stalls, watch: w } = watch();
		w.observe({ type: "agent_start" });
		vi.advanceTimersByTime(AGENT_STALL_MS - 1);
		expect(stalls).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(stalls).toEqual([600]);
		w.observe({ type: "message_update" });
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([600]);
	});

	it("counts every streamed chunk as progress", () => {
		const { stalls, watch: w } = watch();
		w.observe({ type: "agent_start" });
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(AGENT_STALL_MS - 1000);
			w.observe({ type: "message_update" });
		}
		expect(stalls).toEqual([]);
	});

	it("pauses while a tool runs or the session compacts, and counts again after", () => {
		const { stalls, watch: w } = watch();
		w.observe({ type: "agent_start" });
		w.observe({ type: "tool_execution_start" });
		w.observe({ type: "tool_execution_start" });
		vi.advanceTimersByTime(AGENT_STALL_MS * 3);
		w.observe({ type: "tool_execution_end" });
		vi.advanceTimersByTime(AGENT_STALL_MS * 3);
		expect(stalls).toEqual([]);
		w.observe({ type: "tool_execution_end" });
		w.observe({ type: "compaction_start" });
		vi.advanceTimersByTime(AGENT_STALL_MS * 3);
		expect(stalls).toEqual([]);
		w.observe({ type: "compaction_end" });
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600]);
	});

	it("stops when the turn settles, and watches the next turn afresh", () => {
		const { stalls, watch: w } = watch();
		w.observe({ type: "agent_start" });
		w.observe({ type: "agent_settled" });
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([]);
		// Between turns nothing counts.
		w.observe({ type: "message_update" });
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([]);
		w.observe({ type: "agent_start" });
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600]);
		w.observe({ type: "agent_settled" });
		w.observe({ type: "agent_start" });
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600, 600]);
	});

	it("counts every raw provider event as progress, but only during a turn", () => {
		const { stalls, watch: w } = watch();
		w.progress();
		vi.advanceTimersByTime(AGENT_STALL_MS * 2);
		expect(stalls).toEqual([]);
		w.observe({ type: "agent_start" });
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(AGENT_STALL_MS - 1000);
			w.progress();
		}
		expect(stalls).toEqual([]);
		vi.advanceTimersByTime(AGENT_STALL_MS);
		expect(stalls).toEqual([600]);
	});

	it("hears the child's provider events through its extension", () => {
		const handlers = new Map<string, () => void>();
		const tracker = new SessionTurnTracker();
		let heard = 0;
		tracker.onStreamEvent = () => heard++;
		streamProgressExtension(tracker)({ on: ((name: string, handler: () => void) => handlers.set(name, handler)) as never });
		handlers.get("provider_stream_event")?.();
		handlers.get("provider_stream_event")?.();
		expect(heard).toBe(2);
	});

	it("says why in Claude Code's words", () => {
		expect(subagentResultText().stalled({ seconds: 600 })).toBe("Agent stalled: no progress for 600s (stream watchdog did not recover)");
	});
});

describe("a subagent run whose stream goes silent", () => {
	it("fails after ten minutes with the stall reason, and aborts the child", async () => {
		vi.useRealTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "stall-run-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		try {
			const runtime = await SubagentRuntime.create(agentDir);
			vi.useFakeTimers();
			let listener: ((event: unknown) => void) | undefined;
			let aborted!: () => void;
			const abortedNow = new Promise<void>((resolve) => { aborted = resolve; });
			const session = {
				subscribe: (fn: (event: unknown) => void) => {
					listener = fn;
					return () => { listener = undefined; };
				},
				abort: vi.fn(async () => aborted()),
				dispose: vi.fn(),
				isIdle: true,
				sessionManager: { getSessionId: () => "child" },
				// The turn starts, then the stream says nothing until the child is aborted.
				prompt: vi.fn(async () => {
					listener?.({ type: "agent_start" });
					listener?.({ type: "message_start", message: { role: "assistant" } });
					await abortedNow;
					listener?.({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
					listener?.({ type: "agent_settled" });
				}),
			};
			vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session } as never);
			vi.spyOn(SubagentRuntime.prototype as never, "admitPrefix").mockResolvedValue((() => {}) as never);
			const handle = runtime.run({ cwd: agentDir, task: "look", onProgress: () => {} });
			await vi.advanceTimersByTimeAsync(AGENT_STALL_MS - 1000);
			expect(session.abort).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1000);
			const result = await handle.result;
			expect(session.abort).toHaveBeenCalled();
			expect(result.failed).toBe(true);
			expect(result.failureReason).toBe("Agent stalled: no progress for 600s (stream watchdog did not recover)");
		} finally {
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
