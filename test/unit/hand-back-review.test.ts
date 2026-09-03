import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../../extensions/auto-mode/actions.ts";
import { awaitHandBackReview, HAND_BACK_REVIEW_TIMEOUT_NOTE, withReview } from "../../extensions/subagents/hand-back-review.ts";

const run = { taskId: "t1", name: "worker" };
const actions = [{ toolName: "bash", subject: "rm -rf build" }];

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
		await expect(awaitHandBackReview(events, run, [])).resolves.toBeUndefined();
		await expect(awaitHandBackReview(events, run, undefined)).resolves.toBeUndefined();
		expect(emitted).toHaveLength(0);
	});

	it("emits the actions on the channel as a background payload with a callback", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, actions);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].channel).toBe(SUBAGENT_ACTIONS_CHANNEL);
		expect(emitted[0].payload).toMatchObject({ toolCallId: "t1", agentName: "worker", background: true, actions });
		emitted[0].payload.onReview?.(undefined);
		await expect(pending).resolves.toBeUndefined();
	});

	it("resolves with the gate's rendered flag", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, actions);
		emitted[0].payload.onReview?.("<system-reminder>flagged</system-reminder>");
		await expect(pending).resolves.toBe("<system-reminder>flagged</system-reminder>");
	});

	it("falls back to the timeout note when nobody answers, and ignores a late answer", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, actions, 1000);
		vi.advanceTimersByTime(1000);
		await expect(pending).resolves.toBe(HAND_BACK_REVIEW_TIMEOUT_NOTE);
		expect(() => emitted[0].payload.onReview?.("late")).not.toThrow();
	});

	it("takes the first answer only", async () => {
		const { events, emitted } = capturingEvents();
		const pending = awaitHandBackReview(events, run, actions, 1000);
		emitted[0].payload.onReview?.(undefined);
		emitted[0].payload.onReview?.("second");
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
