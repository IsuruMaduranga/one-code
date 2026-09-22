import { afterEach, describe, expect, it, vi } from "vitest";
import {
	agentMessage,
	awaitOneShotTurn,
	createTaskNotifier,
	frameForDelivery,
	TASK_OUTPUT_DELIVERED_CHANNEL,
	handBackPointer,
	mergeNotificationTexts,
	NOTIFICATION_BATCH_KEY,
	NOTIFICATION_ID_KEY,
	notificationBody,
	sessionOutlivesTurn,
	shellSummary,
	taskNotification,
} from "../../extensions/lib/notifications.ts";

/** A kind=shell notification for a finished background command. */
const shellDone = (id: string, tail?: string) =>
	taskNotification({ kind: "shell", taskId: id, status: "completed", summary: shellSummary(`build ${id}`, "completed", 0), result: tail });

type Handler = (event: unknown, ctx: unknown) => void;

/** A pi stub: records sendMessage calls and lets the test fire lifecycle events. */
function fakePi(options: { prompted?: boolean; sendThrows?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const sentAsUser: string[] = [];
	const channels = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				channels.set(channel, [...(channels.get(channel) ?? []), handler]);
			},
			emit(channel: string, data: unknown) {
				for (const h of channels.get(channel) ?? []) h(data);
			},
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
	return { pi: pi as never, sent, sentAsUser, fire, deliver, primed, emit: pi.events.emit };
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
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		fire("agent_start"); // mid-turn: the frames ride the bare preamble, no reminder wrapper
		notify("task-notification", shellDone("1", "out A"), { taskId: "1" });
		notify("task-notification", shellDone("2", "out B"), { taskId: "2" });
		notify("task-notification", shellDone("3"), { taskId: "3" });
		expect(sent).toHaveLength(0);
		vi.advanceTimersByTime(249);
		expect(sent).toHaveLength(0);
		vi.advanceTimersByTime(1);

		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(sent[0].message.customType).toBe("task-notification");
		const text = (sent[0].message.content as Array<{ text: string }>)[0].text;
		// Three self-delimiting frames, a blank line apart, in arrival order (CC delivers all pending in one round).
		expect(text.match(/<task-notification>/g)).toHaveLength(3);
		expect(text).toBe(frameForDelivery([shellDone("1", "out A"), shellDone("2", "out B"), shellDone("3")].join("\n\n"), "mid-turn"));
		expect(text.indexOf("<task-id>1</task-id>")).toBeLessThan(text.indexOf("<task-id>2</task-id>"));
		expect(text.indexOf("<task-id>2</task-id>")).toBeLessThan(text.indexOf("<task-id>3</task-id>"));
		const details = sent[0].message.details as Record<string, unknown>;
		expect(details[NOTIFICATION_BATCH_KEY]).toEqual([
			{ customType: "task-notification", details: { taskId: "1" } },
			{ customType: "task-notification", details: { taskId: "2" } },
			{ customType: "task-notification", details: { taskId: "3" } },
		]);
		expect(typeof details[NOTIFICATION_ID_KEY]).toBe("string");
	});

	it("a fired wakeup or loop tick is never merged with frames: it is the turn's input, sent on its own in arrival order", () => {
		vi.useFakeTimers();
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250 });
		primed();
		fire("agent_start");
		notify("task-notification", shellDone("1"), { taskId: "1" });
		notify("wakeup", "check the deploy", { reason: "r" });
		notify("task-notification", shellDone("2"), { taskId: "2" });
		notify("task-notification", shellDone("3"), { taskId: "3" });
		vi.advanceTimersByTime(250);
		expect(sent.map((s) => s.message.customType)).toEqual(["task-notification", "wakeup", "task-notification"]);
		expect(sent[1].message.content).toEqual([{ type: "text", text: "check the deploy" }]);
		expect((sent[1].message.details as Record<string, unknown>).reason).toBe("r");
		expect((sent[2].message.content as Array<{ text: string }>)[0].text).toBe(frameForDelivery([shellDone("2"), shellDone("3")].join("\n\n"), "mid-turn"));
	});

	it("frames a task notification for its delivery: reminder-wrapped when it opens a turn, bare preamble mid-turn, the with-user-turn variant after an interrupt", () => {
		vi.useFakeTimers();
		const { pi, sent, fire, primed } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 0 });
		primed();
		notify("task-notification", shellDone("1"), { taskId: "1" });
		expect((sent[0].message.content as Array<{ text: string }>)[0].text).toBe(frameForDelivery(shellDone("1"), "opens-turn"));
		fire("agent_start");
		notify("task-notification", shellDone("2"), { taskId: "2" });
		expect((sent[1].message.content as Array<{ text: string }>)[0].text).toBe(frameForDelivery(shellDone("2"), "mid-turn"));
		fire("agent_end", { messages: [] });
		fire("agent_settled");
		// Interrupted: the next notification waits for the user's prompt, framed as riding with it.
		fire("agent_start");
		fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		fire("agent_settled");
		notify("task-notification", shellDone("3"), { taskId: "3" });
		const held = sent.at(-1)!;
		expect(held.options).toEqual({ deliverAs: "nextTurn" });
		expect((held.message.content as Array<{ text: string }>)[0].text).toBe(frameForDelivery(shellDone("3"), "with-user-prompt"));
	});

	it("withdraws a completion still in the window once task_output delivered that task's output (opt-in per notifier)", () => {
		vi.useFakeTimers();
		const { pi, sent, fire, primed, emit } = fakePi();
		const notify = createTaskNotifier(pi, { coalesceMs: 250, withdrawOnDelivery: true });
		primed();
		fire("agent_start");
		notify("task-notification", shellDone("1"), { taskId: "1" });
		notify("task-notification", shellDone("2"), { taskId: "2" });
		emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "1" });
		vi.advanceTimersByTime(250);
		expect(sent).toHaveLength(1);
		expect((sent[0].message.content as Array<{ text: string }>)[0].text).toBe(frameForDelivery(shellDone("2"), "mid-turn"));
		// Without the option nothing is withdrawn.
		const other = fakePi();
		const notifyAgent = createTaskNotifier(other.pi, { coalesceMs: 250 });
		other.primed();
		notifyAgent("subagent-result", shellDone("3"), { taskId: "3" });
		other.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "3" });
		vi.advanceTimersByTime(250);
		expect(other.sent).toHaveLength(1);
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

	it("joins frames with a blank line and keeps a hand-back's message ahead of its pointer", () => {
		const report = agentMessage({ from: "a1", body: "line 1\n\nline 3", handBack: true });
		const pointer = taskNotification({ kind: "agent", taskId: "a1", status: "completed", summary: 'Agent "explore-1" finished', result: handBackPointer("a1", false) });
		const merged = mergeNotificationTexts([report, pointer, "plain B"]);
		expect(merged).toBe(`${report}\n\n${pointer}\n\nplain B`);
		expect(merged.indexOf("<agent-message")).toBeLessThan(merged.indexOf("<task-notification>"));
	});

	it("reduces a task notification to its summary and unescaped body for display", () => {
		const text = taskNotification({ kind: "shell", taskId: "b1", status: "completed", summary: shellSummary("run <tests>", "completed", 0), result: "a < b && c" });
		expect(notificationBody(text)).toBe('Background command "run <tests>" completed (exit code 0)\na < b && c');
		const batch = taskNotification({ kind: "monitor", taskId: "m1", summary: 'Monitor event: "log"', result: "l1\nl2" });
		expect(notificationBody(batch)).toBe('Monitor event: "log"\nl1\nl2');
		expect(notificationBody("plain text\n")).toBe("plain text");
		// The send-time framing (preamble, reminder wrapper) never shows.
		for (const delivery of ["mid-turn", "opens-turn", "with-user-prompt"] as const) {
			expect(notificationBody(frameForDelivery(batch, delivery))).toBe('Monitor event: "log"\nl1\nl2');
		}
	});

	it("reduces a hand-back to the sender line and the de-indented report, guard and preamble dropped", () => {
		const text = agentMessage({ from: "a1", body: "first\n\n  indented already", handBack: true, warning: "<system-reminder>\nflag\n</system-reminder>" });
		expect(notificationBody(text)).toBe("Report from agent a1:\n<system-reminder>\nflag\n</system-reminder>\nfirst\n\n  indented already");
		expect(notificationBody(text)).not.toContain("permission laundering");
		expect(notificationBody(agentMessage({ from: "a2", body: "hello" }))).toBe("Message from agent a2:\nhello");
		// The mid-turn form (other opener, reply hint after the guard) parses the same way.
		expect(notificationBody(agentMessage({ from: "a2", body: "hello", midTurn: true }))).toBe("Message from agent a2:\nhello");
	});

	it("renders every frame of a coalesced message, in order", () => {
		const merged = mergeNotificationTexts([
			agentMessage({ from: "a1", body: "report", handBack: true }),
			taskNotification({ kind: "agent", taskId: "a1", status: "completed", summary: 'Agent "x" finished', result: handBackPointer("a1", false) }),
		]);
		expect(notificationBody(merged)).toBe(`Report from agent a1:\nreport\n\nAgent "x" finished\n${handBackPointer("a1", false).trim()}`);
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
