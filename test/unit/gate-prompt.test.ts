import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { bindGatePrompt, openGatePrompt } from "../../extensions/lib/consent/gate-prompt.ts";
import {
	AttentionNotifier,
	type DesktopNotification,
	INTERACTION_THRESHOLD_MS,
	PROMPT_ATTENTION_CHANNEL,
	PROMPT_ATTENTION_WITHDRAWN_CHANNEL,
	type PromptAttention,
	type PromptAttentionWithdrawn,
} from "../../extensions/lib/notify/desktop.ts";
import { recordPromptDescriptions } from "./helpers/fake-pi.ts";

/** A bus that records descriptions and withdrawals, and forwards both to `listener`. */
function bus(listener?: (channel: string, data: unknown) => void) {
	const events = createEventBus();
	const log = recordPromptDescriptions(events);
	events.on(PROMPT_ATTENTION_WITHDRAWN_CHANNEL, () => log.push("withdrawn"));
	if (listener) {
		events.on(PROMPT_ATTENTION_CHANNEL, (data) => listener(PROMPT_ATTENTION_CHANNEL, data));
		events.on(PROMPT_ATTENTION_WITHDRAWN_CHANNEL, (data) => listener(PROMPT_ATTENTION_WITHDRAWN_CHANNEL, data));
	}
	return { events, log };
}

describe("openGatePrompt", () => {
	it("announces the description, opens the prompt, returns its answer, then withdraws the description", async () => {
		const { events, log } = bus();
		const answer = await openGatePrompt({
			events,
			attention: "Prod needs your permission to use Bash",
			open: async () => {
				log.push("opened");
				return "Yes";
			},
		});
		expect(answer).toBe("Yes");
		expect(log).toEqual(["described: Prod needs your permission to use Bash", "opened", "withdrawn"]);
	});

	it("withdraws the description it announced, and only that one", async () => {
		const ids: unknown[] = [];
		const { events } = bus((channel, data) => ids.push((data as { id: unknown }).id));
		await openGatePrompt({ events, attention: "described", open: async () => "Yes" });
		expect(ids).toHaveLength(2);
		expect(typeof ids[0]).toBe("object");
		expect(ids[1]).toBe(ids[0]);
	});

	it("opens an undescribed prompt without announcing or withdrawing anything", async () => {
		const { events, log } = bus();
		const open = vi.fn(async () => "typed");
		expect(await openGatePrompt({ events, attention: undefined, open })).toBe("typed");
		expect(open).toHaveBeenCalledOnce();
		expect(log).toEqual([]);
	});

	it("neither announces nor opens when the signal is already aborted", async () => {
		const { events, log } = bus();
		const controller = new AbortController();
		controller.abort();
		const open = vi.fn(async () => "Yes");
		expect(await openGatePrompt({ events, attention: "described", signal: controller.signal, open })).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("withdraws the description when the signal aborts while the prompt is open", async () => {
		const { events, log } = bus();
		const controller = new AbortController();
		const answer = await openGatePrompt({
			events,
			attention: "described",
			signal: controller.signal,
			open: () =>
				new Promise<string | undefined>((resolve) => {
					controller.signal.addEventListener("abort", () => resolve(undefined));
					controller.abort();
				}),
		});
		expect(answer).toBeUndefined();
		expect(log).toEqual(["described: described", "withdrawn"]);
	});

	it("neither announces nor opens with no UI (the gate fails closed)", async () => {
		const { events, log } = bus();
		const open = vi.fn(async () => "Yes");
		expect(await openGatePrompt({ events, attention: "described", hasUI: () => false, open })).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("lets a throwing UI check propagate without announcing or opening (a stale context)", async () => {
		const { events, log } = bus();
		const open = vi.fn(async () => "Yes");
		await expect(openGatePrompt({ events, attention: "described", hasUI: () => { throw new Error("stale ctx"); }, open })).rejects.toThrow("stale ctx");
		expect(open).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("withdraws the description when the opener rejects, and passes the rejection through", async () => {
		const { events, log } = bus();
		await expect(openGatePrompt({ events, attention: "described", open: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
		expect(log).toEqual(["described: described", "withdrawn"]);
	});

	it("withdraws the description when the opener throws before returning a promise", async () => {
		const { events, log } = bus();
		const open = (): Promise<string> => {
			throw new Error("This extension ctx is stale");
		};
		await expect(openGatePrompt({ events, attention: "described", open })).rejects.toThrow("stale");
		expect(log).toEqual(["described: described", "withdrawn"]);
	});
});

describe("bindGatePrompt", () => {
	it("opens through openGatePrompt, reading the context's UI when the prompt opens", async () => {
		const { events, log } = bus();
		const ctx = { hasUI: false };
		const gate = bindGatePrompt(events, ctx);
		const open = vi.fn(async () => "Yes");
		expect(await gate("described", undefined, open)).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
		ctx.hasUI = true;
		expect(await gate("described", undefined, open)).toBe("Yes");
		expect(log).toEqual(["described: described", "withdrawn"]);
	});
});

/** The desktop notifier on a hand-driven clock, fed from the bus as the desktop-notify extension feeds it. */
function notifierOnBus() {
	let now = 1_000_000;
	const timers: Array<{ at: number; every: number; fn: () => void; live: boolean }> = [];
	const sent: DesktopNotification[] = [];
	const notifier = new AttentionNotifier(
		{
			now: () => now,
			every: (ms, fn) => {
				const timer = { at: now + ms, every: ms, fn, live: true };
				timers.push(timer);
				return () => void (timer.live = false);
			},
			after: (ms, fn) => {
				const timer = { at: now + ms, every: 0, fn, live: true };
				timers.push(timer);
				return () => void (timer.live = false);
			},
			notify: (n) => sent.push(n),
		},
		"Prod",
	);
	const advance = (ms: number) => {
		now += ms;
		for (const timer of timers) {
			while (timer.live && timer.at <= now) {
				if (timer.every) timer.at += timer.every;
				else timer.live = false;
				timer.fn();
			}
		}
	};
	const { events } = bus((channel, data) => {
		if (channel === PROMPT_ATTENTION_CHANNEL) notifier.describeNextPrompt((data as PromptAttention).message, (data as PromptAttention).id);
		if (channel === PROMPT_ATTENTION_WITHDRAWN_CHANNEL) notifier.withdrawPrompt((data as PromptAttentionWithdrawn).id);
	});
	return { notifier, events, sent, advance };
}

describe("openGatePrompt and the desktop notifier", () => {
	// The bug: a described prompt that never opened left its description behind,
	// and the next prompt to open (a panel the user opened while idle) took it,
	// notifying "needs your permission" 6 s later for the user's own panel.
	it("a described prompt that never opened leaves no description for the user's next panel", async () => {
		const h = notifierOnBus();
		await expect(
			openGatePrompt({
				events: h.events,
				attention: "Prod needs your permission to use Bash",
				open: () => {
					throw new Error("This extension ctx is stale");
				},
			}),
		).rejects.toThrow();
		h.notifier.promptOpened(); // the user opens /permissions while idle
		h.advance(60_000);
		expect(h.sent).toEqual([]);
	});

	it("a described prompt pi never reported opening (nested in another prompt) leaves no description behind", async () => {
		const h = notifierOnBus();
		await openGatePrompt({ events: h.events, attention: "Prod needs your permission to use Bash", open: async () => "Yes" });
		h.notifier.promptOpened();
		h.advance(60_000);
		expect(h.sent).toEqual([]);
	});

	it("a described prompt that opens still notifies by its description while it waits", async () => {
		const h = notifierOnBus();
		let answer!: (choice: string) => void;
		const pending = openGatePrompt({
			events: h.events,
			attention: "Prod needs your permission to use Bash",
			open: () =>
				new Promise<string>((resolve) => {
					h.notifier.promptOpened(); // pi's ui_prompt_start
					answer = (choice) => {
						h.notifier.promptClosed(); // pi's ui_prompt_end
						resolve(choice);
					};
				}),
		});
		h.advance(INTERACTION_THRESHOLD_MS);
		expect(h.sent).toEqual([{ message: "Prod needs your permission to use Bash", notificationType: "permission_prompt" }]);
		answer("Yes");
		expect(await pending).toBe("Yes");
	});
});
