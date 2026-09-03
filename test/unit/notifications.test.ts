import { describe, expect, it } from "vitest";
import { createTaskNotifier, NOTIFICATION_ID_KEY, sessionOutlivesTurn, systemNotification } from "../../extensions/lib/notifications.ts";

type Handler = (event: unknown, ctx: unknown) => void;

/** A pi stub: records sendMessage calls and lets the test fire lifecycle events. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
			sent.push({ message, options });
		},
	};
	const fire = (event: string, payload: unknown = {}) => {
		for (const h of handlers.get(event) ?? []) h(payload, {});
	};
	/** Simulate pi draining a queued custom message: message_end carrying its details. */
	const deliver = (index: number) => {
		const details = sent[index]?.message.details;
		fire("message_end", { message: { role: "custom", details } });
	};
	return { pi: pi as never, sent, fire, deliver };
}

describe("createTaskNotifier", () => {
	it("steers with triggerTurn and stamps an outbox id into details", () => {
		const { pi, sent } = fakePi();
		const notify = createTaskNotifier(pi);
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
		const { pi, sent, fire, deliver } = fakePi();
		const notify = createTaskNotifier(pi);
		notify("task-notification", "bash finished");
		deliver(0);
		fire("agent_settled");
		expect(sent).toHaveLength(1);
	});

	it("re-sends a notification still undelivered at settle (Esc cleared pi's queue)", () => {
		const { pi, sent, fire, deliver } = fakePi();
		const notify = createTaskNotifier(pi);
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
		const { pi, sent, fire } = fakePi();
		const notify = createTaskNotifier(pi);
		notify("one-code:workflow-result", "report");
		fire("agent_settled");
		fire("agent_settled");
		fire("agent_settled");
		expect(sent).toHaveLength(2);
	});

	it("ignores message_end for messages that are not its own", () => {
		const { pi, sent, fire } = fakePi();
		const notify = createTaskNotifier(pi);
		notify("subagent-result", "report");
		fire("message_end", { message: { role: "assistant" } });
		fire("message_end", { message: { role: "custom", details: { [NOTIFICATION_ID_KEY]: "someone-else" } } });
		fire("message_end", { message: { role: "custom" } });
		fire("agent_settled");
		expect(sent).toHaveLength(2);
	});

	it("forgets pending notices when the session is replaced", () => {
		const { pi, sent, fire } = fakePi();
		const notify = createTaskNotifier(pi);
		notify("subagent-result", "report");
		fire("session_start");
		fire("agent_settled");
		expect(sent).toHaveLength(1);
	});

	it("tracks each notification independently", () => {
		const { pi, sent, fire, deliver } = fakePi();
		const notify = createTaskNotifier(pi);
		notify("a", "first");
		notify("b", "second");
		deliver(0);
		fire("agent_settled");
		expect(sent).toHaveLength(3);
		expect(sent[2].message.customType).toBe("b");
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

describe("systemNotification", () => {
	it("frames the body with the anti-confabulation header", () => {
		const text = systemNotification("body");
		expect(text.startsWith("SYSTEM NOTIFICATION — NOT USER INPUT\n")).toBe(true);
		expect(text.endsWith("\n\nbody")).toBe(true);
	});
});
