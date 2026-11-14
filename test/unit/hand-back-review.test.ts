import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../../extensions/lib/rules/auto-mode-actions.ts";
import { withReview } from "../../extensions/lib/notify/notifications.ts";
import { awaitHandBackReview, handBackReviewTimeoutVerdict } from "../../extensions/agents/subagents/hand-back-review.ts";

const run = { taskId: "t1", name: "worker" };
const actions = [{ toolName: "bash", input: { command: "rm -rf build" } }];

function capturingEvents() {
	const emitted: Array<{ channel: string; payload: SubagentActionsPayload }> = [];
	return {
		emitted,
		events: {
			emit(channel: string, data: unknown) {
				emitted.push({ channel, payload: data as SubagentActionsPayload });
			},
		},
	};
}

describe("awaitHandBackReview", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("resolves immediately without emitting when the turn took no actions", async () => {
		const { events, emitted } = capturingEvents();
		await expect(awaitHandBackReview(events, run, { actions: [], output: "report" })).resolves.toBeUndefined();
		expect(emitted).toHaveLength(0);
	});

	it("emits the actions on the channel as a background payload with a callback", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, { actions, output: "report" });
		expect(emitted).toHaveLength(1);
		expect(emitted[0].channel).toBe(SUBAGENT_ACTIONS_CHANNEL);
		expect(emitted[0].payload).toMatchObject({ toolCallId: "t1", agentName: "worker", background: true, actions, report: "report" });
		emitted[0].payload.onReview?.(undefined);
		await expect(pending).resolves.toBeUndefined();
	});

	it("resolves with the gate's verdict", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, { actions, output: "report" });
		emitted[0].payload.onReview?.({ kind: "blocked", reason: "read a token" });
		await expect(pending).resolves.toEqual({ kind: "blocked", reason: "read a token" });
	});

	it("falls back to the timeout note when nobody answers, and ignores a late answer", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, { actions, output: "report" }, { timeoutMs: 1000 });
		vi.advanceTimersByTime(1000);
		await expect(pending).resolves.toEqual(handBackReviewTimeoutVerdict());
		expect(() => emitted[0].payload.onReview?.({ kind: "blocked", reason: "late" })).not.toThrow();
	});

	it("takes the first answer only", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, { actions, output: "report" }, { timeoutMs: 1000 });
		emitted[0].payload.onReview?.(undefined);
		emitted[0].payload.onReview?.({ kind: "blocked", reason: "second" });
		vi.advanceTimersByTime(1000);
		await expect(pending).resolves.toBeUndefined();
	});
});

describe("withReview", () => {
	it("puts the flag ahead of the report and leaves a clean report untouched", () => {
		expect(withReview("report", undefined)).toBe("report");
		expect(withReview("report", "FLAG")).toBe("FLAG\n\nreport");
	});
});
