import { afterEach, describe, expect, it, vi } from "vitest";
import {
	awaitOneShotTurn,
	createTaskNotifier,
	mergeNotificationTexts,
	NOTIFICATION_BATCH_KEY,
	NOTIFICATION_ID_KEY,
	notificationBody,
	sessionOutlivesTurn,
	systemNotification,
} from "../../extensions/lib/notifications.ts";

type Handler = (event: unknown, ctx: unknown) => void;

/** A pi stub: records sendMessage calls and lets the test fire lifecycle events. */
function fakePi(options: { prompted?: boolean; sendThrows?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const sentAsUser: string[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
			if (options && (pi as { throws?: boolean }).throws) throw new Error("Extension API is no longer active");
			sent.push({ message, options });
		},
		sendUserMessage(text: string) {
			sentAsUser.push(text);
		},
		throws: options.sendThrows ?? false,
	};
	const fire = (event: string, payload: unknown = {}) => {
		for (const h of handlers.get(event) ?? []) h(payload, {});
	};
	// Most tests model an established session: a prompt() has run, so
	// notifications take the custom-message path (see createTaskNotifier).
	const primed = () => {
		if (options.prompted ?? true) fire("before_agent_start");
	};
	/** Simulate pi draining a queued custom message: message_end carrying its details. */
	const deliver = (index: number) => {
		const details = sent[index]?.message.details;
		fire("message_end", { message: { role: "custom", details } });
	};
	return { pi: pi as never, sent, sentAsUser, fire, deliver, primed };
}

describe("createTaskNotifier", () => {
	it("steers with triggerTurn and stamps an outbox id into details", () => {
		const { pi, sent, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("subagent-result", "done", { taskId: "t1" });

		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(sent[0].message.customType).toBe("subagent-result");
		expect(sent[0].message.display).toBe(true);
		expect(sent[0].message.content).toEqual([{ type: "text", text: "done" }]);
		const details = sent[0].message.details as Record<string, unknown>;
		expect(details.taskId).toBe("t1");
		expect(typeof details[NOTIFICATION_ID_KEY]).toBe("string");
	});

	it("does not re-send a notification pi confirmed with message_end", () => {
		const { pi, sent, fire, deliver, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("task-notification", "bash finished");
		deliver(0);
		fire("agent_settled");
		expect(sent).toHaveLength(1);
	});

	it("re-sends a notification still undelivered at settle (Esc cleared pi's queue)", () => {
		const { pi, sent, fire, deliver, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("subagent-result", "report");
		fire("agent_settled");

		expect(sent).toHaveLength(2);
		expect(sent[1].message.content).toEqual(sent[0].message.content);
		expect(sent[1].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		// Same outbox id, so the re-send's message_end clears the same entry.
		expect((sent[1].message.details as Record<string, unknown>)[NOTIFICATION_ID_KEY]).toBe(
			(sent[0].message.details as Record<string, unknown>)[NOTIFICATION_ID_KEY],
		);
		deliver(1);
		fire("agent_settled");
		expect(sent).toHaveLength(2);
	});

	it("re-sends at most once, then drops the entry instead of looping a turn per settle", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("one-code:workflow-result", "report");
		fire("agent_settled");
		fire("agent_settled");
		fire("agent_settled");
		expect(sent).toHaveLength(2);
	});

	it("ignores message_end for messages that are not its own", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("subagent-result", "report");
		fire("message_end", { message: { role: "assistant" } });
		fire("message_end", { message: { role: "custom", details: { [NOTIFICATION_ID_KEY]: "someone-else" } } });
		fire("message_end", { message: { role: "custom" } });
		fire("agent_settled");
		expect(sent).toHaveLength(2);
	});

	it("forgets pending notices when the session is replaced", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("subagent-result", "report");
		fire("session_start");
		fire("agent_settled");
		expect(sent).toHaveLength(1);
	});

	it("tracks each notification independently", () => {
		const { pi, sent, fire, deliver, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("a", "first");
		notify("b", "second");
		deliver(0);
		fire("agent_settled");
		expect(sent).toHaveLength(3);
		expect(sent[2].message.customType).toBe("b");
	});
});

describe("createTaskNotifier after the session is gone (H3)", () => {
	it("drops a notification dispatched after session_shutdown instead of calling the dead API", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		fire("session_shutdown");
		notify("task-notification", "bash finished after /clear");
		fire("agent_settled");
		expect(sent).toHaveLength(0);
	});

	it("swallows a sendMessage that throws (assertActive) and does not re-send it", () => {
		const { pi, sent, fire, primed } = fakePi({ sendThrows: true });
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		expect(() => notify("task-notification", "late completion")).not.toThrow();
		fire("agent_settled");
		expect(sent).toHaveLength(0);
	});

	it("comes back to life with the next session_start", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		fire("session_shutdown");
		fire("session_start");
		primed();
		notify("task-notification", "new session's task");
		expect(sent).toHaveLength(1);
	});
});

describe("createTaskNotifier before the first prompt (H1)", () => {
	it("delivers an idle notification as a user message while no prompt() has run, then counts it delivered", () => {
		const { pi, sent, sentAsUser, fire } = fakePi({ prompted: false });
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		notify("loop", "Loop tick — run the task");
		expect(sentAsUser).toEqual(["Loop tick — run the task"]);
		expect(sent).toHaveLength(0);
		// No message_end can confirm a user message; it must not be re-sent at settle.
		fire("agent_settled");
		expect(sent).toHaveLength(0);
		expect(sentAsUser).toHaveLength(1);
	});

	it("uses the custom-message path once before_agent_start has fired, and while a run is active", () => {
		const { pi, sent, sentAsUser, fire, deliver } = fakePi({ prompted: false });
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		// A run opened by something else is in flight: a user-role prompt would be
		// refused by pi (no streamingBehavior), so steer the custom message.
		fire("agent_start");
		notify("subagent-result", "mid-run report");
		expect(sent).toHaveLength(1);
		expect(sentAsUser).toHaveLength(0);
		deliver(0);
		fire("agent_settled");
		fire("before_agent_start");
		fire("agent_settled");
		notify("subagent-result", "later report");
		expect(sent.filter((s) => s.message.content && JSON.stringify(s.message.content).includes("later report"))).toHaveLength(1);
		expect(sentAsUser).toHaveLength(0);
	});
});

describe("createTaskNotifier coalescing (M1)", () => {
	afterEach(() => vi.useRealTimers());

	it("merges notifications that arrive within the window into one message, in arrival order", () => {
		vi.useFakeTimers();
		const { pi, sent, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		notify("task-notification", systemNotification("Background bash 1 completed.\n\nout A"), { taskId: "1" });
		notify("task-notification", systemNotification("Background bash 2 completed.\n\nout B"), { taskId: "2" });
		notify("task-notification", systemNotification("Background bash 3 completed."), { taskId: "3" });
		expect(sent).toHaveLength(0);
		vi.advanceTimersByTime(249);
		expect(sent).toHaveLength(0);
		vi.advanceTimersByTime(1);

		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(sent[0].message.customType).toBe("task-notification");
		const text = (sent[0].message.content as Array<{ text: string }>)[0].text;
		// One frame, three bodies, numbered in arrival order.
		expect(text.startsWith("SYSTEM NOTIFICATION — NOT USER INPUT\n")).toBe(true);
		expect(text.match(/SYSTEM NOTIFICATION/g)).toHaveLength(1);
		expect(text).toContain("3 events arrived together");
		expect(text.indexOf("Event 1 of 3")).toBeLessThan(text.indexOf("Event 2 of 3"));
		expect(text.indexOf("Event 2 of 3")).toBeLessThan(text.indexOf("Event 3 of 3"));
		expect(text).toContain("out A");
		expect(text).toContain("out B");
		const details = sent[0].message.details as Record<string, unknown>;
		expect(details[NOTIFICATION_BATCH_KEY]).toEqual([
			{ customType: "task-notification", details: { taskId: "1" } },
			{ customType: "task-notification", details: { taskId: "2" } },
			{ customType: "task-notification", details: { taskId: "3" } },
		]);
		expect(typeof details[NOTIFICATION_ID_KEY]).toBe("string");
	});

	it("a lone notification keeps its own type, text and details (no merge frame)", () => {
		vi.useFakeTimers();
		const { pi, sent, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		notify("subagent-result", "report", { name: "explore-1" });
		vi.advanceTimersByTime(250);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toEqual([{ type: "text", text: "report" }]);
		expect((sent[0].message.details as Record<string, unknown>).name).toBe("explore-1");
		expect((sent[0].message.details as Record<string, unknown>)[NOTIFICATION_BATCH_KEY]).toBeUndefined();
	});

	it("a notification arriving after the window closes opens a new one", () => {
		vi.useFakeTimers();
		const { pi, sent, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		notify("a", "first");
		vi.advanceTimersByTime(250);
		notify("b", "second");
		vi.advanceTimersByTime(250);
		expect(sent).toHaveLength(2);
		expect(sent[1].message.customType).toBe("b");
	});

	it("a merged message is one outbox entry: confirmed once, re-sent once as a whole", () => {
		vi.useFakeTimers();
		const { pi, sent, fire, deliver, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		notify("a", "first");
		notify("a", "second");
		vi.advanceTimersByTime(250);
		fire("agent_settled");
		expect(sent).toHaveLength(2);
		expect(sent[1].message.content).toEqual(sent[0].message.content);
		deliver(1);
		fire("agent_settled");
		expect(sent).toHaveLength(2);
	});

	it("drops a window still open when the session is replaced or shut down", () => {
		vi.useFakeTimers();
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		notify("a", "first");
		fire("session_shutdown");
		vi.advanceTimersByTime(250);
		expect(sent).toHaveLength(0);
	});
});

describe("createTaskNotifier after an interrupted turn (M2)", () => {
	const aborted = { messages: [{ role: "assistant", stopReason: "aborted" }] };
	const errored = { messages: [{ role: "assistant", stopReason: "error" }] };
	const clean = { messages: [{ role: "assistant", stopReason: "stop" }] };

	it("re-sends a notification Esc discarded as nextTurn, so it waits for the user instead of restarting the turn", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		fire("agent_start");
		notify("subagent-result", "report");
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		// Esc: pi clears its queues (no message_end for our steer) and the run ends aborted.
		fire("agent_end", aborted);
		fire("agent_settled");
		expect(sent).toHaveLength(2);
		expect(sent[1].options).toEqual({ deliverAs: "nextTurn" });
		expect(sent[1].message.content).toEqual(sent[0].message.content);
	});

	it("holds new notifications arriving while idle after the interrupt, until the user's next prompt", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		fire("agent_start");
		fire("agent_end", aborted);
		fire("agent_settled");
		notify("task-notification", "bash finished after the interrupt");
		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ deliverAs: "nextTurn" });

		// The user prompts again: the hold ends and later idle notifications start turns as before.
		fire("before_agent_start");
		fire("agent_start");
		fire("agent_end", clean);
		fire("agent_settled");
		notify("task-notification", "later completion");
		expect(sent).toHaveLength(2);
		expect(sent[1].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("treats a turn that settled on an error the same way (pi labels a late abort error, L1)", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		fire("agent_start");
		fire("agent_end", errored);
		fire("agent_settled");
		notify("wakeup", "tick");
		expect(sent[0].options).toEqual({ deliverAs: "nextTurn" });
	});

	it("a mid-turn notification during a later run still steers (the hold applies to idle delivery only)", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		fire("agent_start");
		fire("agent_end", aborted);
		fire("agent_settled");
		// A turn opened by something else (a queued user prompt) is in flight.
		fire("agent_start");
		notify("subagent-result", "mid-run report");
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("a clean settle does not start a hold", () => {
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		fire("agent_start");
		fire("agent_end", clean);
		fire("agent_settled");
		notify("task-notification", "done");
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});
});

describe("mergeNotificationTexts / notificationBody", () => {
	it("returns a single text unchanged", () => {
		expect(mergeNotificationTexts(["x"])).toBe("x");
	});

	it("strips each body's own framing so the merged message carries exactly one", () => {
		const merged = mergeNotificationTexts([systemNotification("A done"), "plain B", systemNotification("C done\n\ntail")]);
		expect(merged.match(/SYSTEM NOTIFICATION/g)).toHaveLength(1);
		expect(notificationBody(merged)).toContain("--- Event 1 of 3 ---\nA done");
		expect(notificationBody(merged)).toContain("--- Event 2 of 3 ---\nplain B");
		expect(notificationBody(merged)).toContain("--- Event 3 of 3 ---\nC done\n\ntail");
	});
});

describe("sessionOutlivesTurn", () => {
	it("keeps notifications for the interactive modes and blocks in the one-shot ones", () => {
		expect(sessionOutlivesTurn("tui")).toBe(true);
		expect(sessionOutlivesTurn("rpc")).toBe(true);
		expect(sessionOutlivesTurn("print")).toBe(false);
		expect(sessionOutlivesTurn("json")).toBe(false);
	});
});

describe("awaitOneShotTurn", () => {
	it("returns immediately in interactive modes without touching idle state", async () => {
		const waitForIdle = vi.fn(async () => {});
		const isIdle = vi.fn(() => false);
		await awaitOneShotTurn({ mode: "tui", isIdle, waitForIdle });
		await awaitOneShotTurn({ mode: "rpc", isIdle, waitForIdle });
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(isIdle).not.toHaveBeenCalled();
	});

	it("awaits waitForIdle in one-shot modes when the context provides it", async () => {
		const waitForIdle = vi.fn(async () => {});
		const isIdle = vi.fn(() => true);
		await awaitOneShotTurn({ mode: "print", isIdle, waitForIdle });
		expect(waitForIdle).toHaveBeenCalledTimes(1);
		expect(isIdle).not.toHaveBeenCalled();
	});

	it("polls isIdle in one-shot modes when there is no waitForIdle, until it reads idle", async () => {
		let calls = 0;
		const isIdle = vi.fn(() => ++calls >= 3); // busy for the first two polls, then idle
		await awaitOneShotTurn({ mode: "json", isIdle });
		expect(calls).toBe(3);
	});
});

describe("systemNotification", () => {
	it("frames the body with the anti-confabulation header", () => {
		const text = systemNotification("body");
		expect(text.startsWith("SYSTEM NOTIFICATION — NOT USER INPUT\n")).toBe(true);
		expect(text.endsWith("\n\nbody")).toBe(true);
	});
});
