import { describe, expect, it } from "vitest";
import { RECAP_PROMPT, RECENT_MESSAGE_WINDOW, recapLine, recentForRecap, REFERENCE_MARK } from "../../extensions/recap/prompt.ts";
import { RecapScheduler, type TimerOps } from "../../extensions/recap/scheduler.ts";

describe("recap prompt", () => {
	it("uses Claude Code's verbatim away-summary instruction", () => {
		expect(RECAP_PROMPT).toBe(
			"The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.",
		);
	});

	it("keeps CC's 30-message recent window and ※ mark", () => {
		expect(RECENT_MESSAGE_WINDOW).toBe(30);
		expect(REFERENCE_MARK).toBe("※");
	});
});

describe("recapLine", () => {
	it("prefixes the trimmed content with 'recap: '", () => {
		expect(recapLine("  Building the recap feature.  ")).toBe("recap: Building the recap feature.");
	});
});

describe("recentForRecap", () => {
	const msg = (role: string, id: string) => ({ role, id });

	it("trims a window that begins mid-exchange to the first user turn (no orphan tool_result)", () => {
		const window = [
			msg("tool", "orphan-result"), // matching tool_use fell outside the window
			msg("assistant", "a1"),
			msg("user", "u1"),
			msg("assistant", "a2"),
			msg("tool", "t2"),
		];
		expect(recentForRecap(window, 5).map((m) => m.id)).toEqual(["u1", "a2", "t2"]);
	});

	it("keeps the whole slice when it already starts at a user turn", () => {
		const window = [msg("user", "u1"), msg("assistant", "a1")];
		expect(recentForRecap(window, 5).map((m) => m.id)).toEqual(["u1", "a1"]);
	});

	it("keeps the whole slice when no user message is present (best effort)", () => {
		const window = [msg("assistant", "a1"), msg("tool", "t1")];
		expect(recentForRecap(window, 5).map((m) => m.id)).toEqual(["a1", "t1"]);
	});

	it("slices to the last `window` messages before trimming", () => {
		const all = Array.from({ length: 40 }, (_, i) => msg(i === 12 ? "user" : "assistant", `m${i}`));
		const result = recentForRecap(all, 30);
		// window = m10..m39; first user in it is m12, so it starts there.
		expect(result[0].id).toBe("m12");
		expect(result.at(-1)?.id).toBe("m39");
	});
});

describe("RecapScheduler", () => {
	// A deterministic fake clock: fire pending callbacks manually.
	function fakeTimer() {
		const pending = new Map<number, () => void>();
		let seq = 0;
		const ops: TimerOps = {
			set(cb) {
				const id = ++seq;
				pending.set(id, cb);
				return id;
			},
			clear(handle) {
				pending.delete(handle as number);
			},
		};
		return {
			ops,
			pendingCount: () => pending.size,
			fireAll: () => {
				for (const cb of [...pending.values()]) cb();
				pending.clear();
			},
		};
	}

	const make = (enabled = () => true) => {
		const clock = fakeTimer();
		let fires = 0;
		const scheduler = new RecapScheduler(clock.ops, () => 1000, enabled, () => fires++);
		return { clock, scheduler, fires: () => fires };
	};

	it("arms on turn end and fires once after the idle delay", () => {
		const { clock, scheduler, fires } = make();
		scheduler.turnStarted();
		scheduler.turnEnded();
		expect(clock.pendingCount()).toBe(1);
		clock.fireAll();
		expect(fires()).toBe(1);
	});

	it("does not fire a second recap before the next turn", () => {
		const { clock, scheduler, fires } = make();
		scheduler.turnEnded();
		clock.fireAll();
		scheduler.markFired(); // extension marks it after emitting
		scheduler.interacted(); // a keystroke must not re-arm a fired turn
		expect(clock.pendingCount()).toBe(0);
		expect(fires()).toBe(1);
	});

	it("re-arms the idle clock on interaction between turns", () => {
		const { clock, scheduler } = make();
		scheduler.turnEnded();
		const first = clock.pendingCount();
		scheduler.interacted();
		expect(first).toBe(1);
		expect(clock.pendingCount()).toBe(1); // re-armed, still one pending
	});

	it("does not arm while a turn is running", () => {
		const { clock, scheduler } = make();
		scheduler.turnStarted();
		scheduler.interacted();
		expect(clock.pendingCount()).toBe(0);
	});

	it("reset() drops a pending timer so a previous session's recap never fires", () => {
		const { clock, scheduler, fires } = make();
		scheduler.turnEnded();
		expect(clock.pendingCount()).toBe(1);
		scheduler.reset(); // e.g. /clear
		expect(clock.pendingCount()).toBe(0);
		clock.fireAll();
		expect(fires()).toBe(0);
	});

	it("stays disarmed when disabled", () => {
		const { clock, scheduler } = make(() => false);
		scheduler.turnEnded();
		expect(clock.pendingCount()).toBe(0);
	});
});
