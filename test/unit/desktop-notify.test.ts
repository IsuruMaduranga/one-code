import { describe, expect, it } from "vitest";
import {
	AttentionNotifier,
	type DesktopNotification,
	detectTerminal,
	IDLE_NOTIFY_MS,
	INTERACTION_THRESHOLD_MS,
	notificationChannel,
	notificationWrites,
	wrapForMultiplexer,
} from "../../extensions/lib/notify/desktop.ts";

/** A notifier on a hand-driven clock: `advance` runs due timers in order. */
function harness() {
	let now = 1_000_000;
	let nextId = 0;
	const timers = new Map<number, { at: number; every?: number; fn: () => void }>();
	const sent: DesktopNotification[] = [];
	const notifier = new AttentionNotifier(
		{
			now: () => now,
			every: (ms, fn) => {
				const id = nextId++;
				timers.set(id, { at: now + ms, every: ms, fn });
				return () => timers.delete(id);
			},
			after: (ms, fn) => {
				const id = nextId++;
				timers.set(id, { at: now + ms, fn });
				return () => timers.delete(id);
			},
			notify: (n) => sent.push(n),
		},
		"Prod",
	);
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [id, timer] = due;
			now = timer.at;
			if (timer.every) timer.at += timer.every;
			else timers.delete(id);
			timer.fn();
		}
		now = end;
	};
	return { notifier, sent, advance, pending: () => timers.size };
}

describe("AttentionNotifier: a prompt that waits", () => {
	it("notifies once, after 6 s with no keypress, with the message the prompt's owner gave", () => {
		const h = harness();
		h.notifier.turnStarted();
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", {});
		h.notifier.promptOpened();
		h.advance(INTERACTION_THRESHOLD_MS - 1);
		expect(h.sent).toEqual([]);
		h.advance(1);
		expect(h.sent).toEqual([{ message: "Prod needs your permission to use Bash", notificationType: "permission_prompt" }]);
		h.advance(60_000);
		expect(h.sent).toHaveLength(1);
	});

	it("waits while the user keeps typing, and says nothing once the prompt closes", () => {
		const h = harness();
		h.notifier.turnStarted();
		h.notifier.promptOpened();
		h.advance(5000);
		h.notifier.interacted();
		h.advance(INTERACTION_THRESHOLD_MS);
		expect(h.sent).toEqual([]);
		h.notifier.promptClosed();
		h.advance(60_000);
		expect(h.sent).toEqual([]);
		expect(h.pending()).toBe(0);
	});

	it("falls back to 'needs your attention' for a prompt nobody described", () => {
		const h = harness();
		h.notifier.turnStarted();
		h.notifier.promptOpened();
		h.advance(INTERACTION_THRESHOLD_MS);
		expect(h.sent[0]?.message).toBe("Prod needs your attention");
	});

	it("never notifies for a panel the user opened while idle", () => {
		const h = harness();
		h.notifier.promptOpened();
		h.advance(60_000);
		expect(h.sent).toEqual([]);
	});

	it("notifies for a described prompt that opens while idle, as a background subagent's permission question does", () => {
		const h = harness();
		h.notifier.submittedPrompt();
		h.notifier.turnStarted();
		h.notifier.turnSettled();
		h.advance(10_000);
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", {});
		h.notifier.promptOpened();
		h.advance(INTERACTION_THRESHOLD_MS);
		expect(h.sent).toEqual([{ message: "Prod needs your permission to use Bash", notificationType: "permission_prompt" }]);
		// The open prompt holds back the idle notification.
		h.advance(IDLE_NOTIFY_MS);
		expect(h.sent).toHaveLength(1);
	});

	it("keeps the idle notification due when a described prompt opens while idle and closes on its own within 6 s", () => {
		const h = harness();
		h.notifier.submittedPrompt();
		h.notifier.turnStarted();
		h.notifier.turnSettled();
		h.advance(10_000);
		// A background agent's question, cancelled when the agent hits its time limit.
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", {});
		h.notifier.promptOpened();
		h.advance(INTERACTION_THRESHOLD_MS - 1000);
		h.notifier.promptClosed();
		expect(h.sent).toEqual([]);
		h.advance(IDLE_NOTIFY_MS);
		expect(h.sent).toEqual([{ message: "Prod is waiting for your input", notificationType: "idle_prompt" }]);
	});

	it("a withdrawn description whose prompt never opened does not make a panel the user opens while idle notify", () => {
		const h = harness();
		const id = {};
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", id);
		h.notifier.withdrawPrompt(id);
		h.notifier.promptOpened();
		h.advance(60_000);
		expect(h.sent).toEqual([]);
	});

	it("a withdrawal leaves a later prompt's description in place", () => {
		const h = harness();
		const earlier = {};
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", earlier);
		h.notifier.describeNextPrompt("Prod needs your approval for the plan", {});
		h.notifier.withdrawPrompt(earlier);
		h.notifier.promptOpened();
		h.advance(INTERACTION_THRESHOLD_MS);
		expect(h.sent).toEqual([{ message: "Prod needs your approval for the plan", notificationType: "permission_prompt" }]);
	});

	it("a withdrawal after the prompt opened changes nothing: the open prompt still notifies by its description", () => {
		const h = harness();
		const id = {};
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", id);
		h.notifier.promptOpened();
		h.notifier.withdrawPrompt(id);
		h.advance(INTERACTION_THRESHOLD_MS);
		expect(h.sent).toEqual([{ message: "Prod needs your permission to use Bash", notificationType: "permission_prompt" }]);
	});

	it("counts a prompt's 6 s from its opening, not from an older keypress", () => {
		const h = harness();
		h.notifier.turnStarted();
		h.notifier.interacted();
		h.advance(30_000);
		h.notifier.describeNextPrompt("Prod needs your permission to use Bash", {});
		h.notifier.promptOpened();
		h.advance(INTERACTION_THRESHOLD_MS - 1);
		expect(h.sent).toEqual([]);
		h.advance(1);
		expect(h.sent).toEqual([{ message: "Prod needs your permission to use Bash", notificationType: "permission_prompt" }]);
	});
});

describe("AttentionNotifier: the user is away after a turn", () => {
	it("says the session waits 60 s after a run the user started settles", () => {
		const h = harness();
		h.notifier.submittedPrompt();
		h.notifier.turnStarted();
		h.notifier.turnSettled();
		h.advance(IDLE_NOTIFY_MS - 1);
		expect(h.sent).toEqual([]);
		h.advance(1);
		expect(h.sent).toEqual([{ message: "Prod is waiting for your input", notificationType: "idle_prompt" }]);
	});

	it("stays quiet when the user touched a key since, a new turn started, or nothing was ever submitted", () => {
		const typed = harness();
		typed.notifier.submittedPrompt();
		typed.notifier.turnSettled();
		typed.advance(10);
		typed.notifier.interacted();
		typed.advance(IDLE_NOTIFY_MS);
		expect(typed.sent).toEqual([]);

		const busy = harness();
		busy.notifier.submittedPrompt();
		busy.notifier.turnSettled();
		busy.notifier.turnStarted();
		busy.advance(IDLE_NOTIFY_MS * 2);
		expect(busy.sent).toEqual([]);

		const scheduled = harness();
		scheduled.notifier.turnStarted();
		scheduled.notifier.turnSettled();
		scheduled.advance(IDLE_NOTIFY_MS * 2);
		expect(scheduled.sent).toEqual([]);
	});

	it("fires nothing after stop", () => {
		const h = harness();
		h.notifier.submittedPrompt();
		h.notifier.turnStarted();
		h.notifier.promptOpened();
		h.notifier.promptClosed();
		h.notifier.turnSettled();
		h.notifier.stop();
		h.advance(IDLE_NOTIFY_MS * 2);
		expect(h.sent).toEqual([]);
		expect(h.pending()).toBe(0);
	});
});

describe("terminal writes", () => {
	const note = { message: "Prod is waiting for your input" };

	it("picks the terminal by Claude Code's order", () => {
		expect(detectTerminal({ TERM: "xterm-ghostty", TERM_PROGRAM: "iTerm.app" })).toBe("ghostty");
		expect(detectTerminal({ TERM: "xterm-kitty" })).toBe("kitty");
		expect(detectTerminal({ TERM_PROGRAM: "iTerm.app" })).toBe("iTerm.app");
		expect(detectTerminal({ TMUX: "/tmp/x" })).toBe("tmux");
		expect(detectTerminal({})).toBeUndefined();
	});

	it("auto: iTerm2's OSC 9, kitty's OSC 99 triple, Ghostty's OSC 777, nothing elsewhere", () => {
		expect(notificationWrites("auto", note, "Prod", { TERM_PROGRAM: "iTerm.app" }, 7)).toEqual(["\x1b]9;\n\nProd is waiting for your input\x07"]);
		expect(notificationWrites("auto", note, "Prod", { TERM: "xterm-kitty" }, 7)).toEqual([
			"\x1b]99;i=7:d=0:p=title;Prod\x1b\\",
			"\x1b]99;i=7:p=body;Prod is waiting for your input\x1b\\",
			"\x1b]99;i=7:d=1:a=focus;\x1b\\",
		]);
		expect(notificationWrites("auto", note, "Prod", { TERM: "xterm-ghostty" }, 7)).toEqual(["\x1b]777;notify;Prod;Prod is waiting for your input\x07"]);
		expect(notificationWrites("auto", note, "Prod", { TERM_PROGRAM: "Apple_Terminal" }, 7)).toEqual([]);
		expect(notificationWrites("auto", note, "Prod", { TERM_PROGRAM: "tmux", TMUX: "/tmp/x" }, 7)).toEqual([]);
	});

	it("honours the chosen channel, wrapping for tmux, and a bare bell", () => {
		expect(notificationWrites("iterm2", note, "Prod", { TMUX: "/tmp/x" }, 7)).toEqual(["\x1bPtmux;\x1b\x1b]9;\n\nProd is waiting for your input\x07\x1b\\"]);
		expect(notificationWrites("iterm2_with_bell", note, "Prod", {}, 7)).toEqual(["\x1b]9;\n\nProd is waiting for your input\x07", "\x07"]);
		expect(notificationWrites("terminal_bell", note, "Prod", { TMUX: "/tmp/x" }, 7)).toEqual(["\x07"]);
		expect(notificationWrites("notifications_disabled", note, "Prod", { TERM_PROGRAM: "iTerm.app" }, 7)).toEqual([]);
	});

	it("keeps control characters out of the sequence", () => {
		const [bytes] = notificationWrites("ghostty", { message: "a\x07b\x1b]c" }, "Prod", {}, 7);
		expect(bytes).toBe("\x1b]777;notify;Prod;a b ]c\x07");
	});

	it("reads an unknown setting as auto", () => {
		expect(notificationChannel("kitty")).toBe("kitty");
		expect(notificationChannel("nonsense")).toBe("auto");
		expect(notificationChannel(undefined)).toBe("auto");
	});

	it("wraps for screen too", () => {
		expect(wrapForMultiplexer("\x1b]9;x\x07", { STY: "1" })).toBe("\x1bP\x1b]9;x\x07\x1b\\");
	});
});
