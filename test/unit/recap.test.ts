import { describe, expect, it } from "vitest";
import { RECENT_MESSAGE_WINDOW, recapLine, recentForRecap, REFERENCE_MARK } from "../../extensions/agents/recap/prompt.ts";
import { type BranchMark, enoughUserTurns, type RecapProbe, recapDelayMs, recapSkip } from "../../extensions/agents/recap/policy.ts";
import { RecapScheduler, type TimerOps } from "../../extensions/agents/recap/scheduler.ts";

describe("recap prompt", () => {
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

	it("drops a leading orphan tool-result, starting at the first turn boundary", () => {
		const window = [
			msg("toolResult", "orphan"), // matching tool_use fell outside the window
			msg("assistant", "a1"),
			msg("user", "u1"),
			msg("assistant", "a2"),
			msg("toolResult", "t2"), // paired with a2 — kept
		];
		expect(recentForRecap(window, 5).map((m) => m.id)).toEqual(["a1", "u1", "a2", "t2"]);
	});

	it("keeps the whole slice when it already starts at a user turn", () => {
		const window = [msg("user", "u1"), msg("assistant", "a1")];
		expect(recentForRecap(window, 5).map((m) => m.id)).toEqual(["u1", "a1"]);
	});

	it("keeps an assistant start (its tool results follow in-window)", () => {
		const window = [msg("assistant", "a1"), msg("toolResult", "t1")];
		expect(recentForRecap(window, 5).map((m) => m.id)).toEqual(["a1", "t1"]);
	});

	it("returns empty when the window is one long tool-only stretch (no safe boundary)", () => {
		// A single user turn with 30+ tool calls fills the window with no user/assistant
		// message; nothing is safe to send, so the recap runs on the instruction alone.
		const window = [msg("toolResult", "t1"), msg("toolResult", "t2"), msg("toolResult", "t3")];
		expect(recentForRecap(window, 5)).toEqual([]);
	});

	it("slices to the last `window` messages before trimming", () => {
		const all = Array.from({ length: 40 }, (_, i) => msg(i === 12 ? "user" : "toolResult", `m${i}`));
		const result = recentForRecap(all, 30);
		// window = m10..m39; first user/assistant in it is m12, so it starts there.
		expect(result[0].id).toBe("m12");
		expect(result.at(-1)?.id).toBe("m39");
	});
});

describe("RecapScheduler", () => {
	// A deterministic fake clock: fire pending callbacks manually.
	function fakeTimer() {
		const pending = new Map<number, () => void>();
		let seq = 0;
		const delays: number[] = [];
		const ops: TimerOps = {
			set(cb, ms) {
				const id = ++seq;
				pending.set(id, cb);
				delays.push(ms);
				return id;
			},
			clear(handle) {
				pending.delete(handle as number);
			},
		};
		return {
			ops,
			lastDelay: () => delays.at(-1),
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
		let now = 0;
		const scheduler = new RecapScheduler(clock.ops, () => now, () => 180_000, enabled, () => fires++);
		return { clock, scheduler, fires: () => fires, at: (ms: number) => (now = ms) };
	};

	it("counts the delay from the turn end: a late keystroke holds it back only 30 seconds", () => {
		const { clock, scheduler, at } = make();
		scheduler.turnEnded();
		expect(clock.lastDelay()).toBe(180_000);
		// A keystroke 100 s in keeps the 180 s mark (restarting the 3 minutes there
		// would fire at 280 s, past a five-minute cache's 270 s stale point).
		at(100_000);
		scheduler.interacted();
		expect(clock.lastDelay()).toBe(80_000);
		// A keystroke 170 s in moves the fire to 30 s after it.
		at(170_000);
		scheduler.interacted();
		expect(clock.lastDelay()).toBe(30_000);
		expect(clock.pendingCount()).toBe(1);
	});

	it("arms on turn end and fires once after the idle delay", () => {
		const { clock, scheduler, fires } = make();
		scheduler.turnStarted();
		scheduler.turnEnded();
		expect(clock.pendingCount()).toBe(1);
		clock.fireAll();
		expect(fires()).toBe(1);
	});

	it("counts failures per turn, and a turn end gives a fresh budget", () => {
		const { scheduler } = make();
		scheduler.turnEnded();
		scheduler.markFailed();
		scheduler.markFailed();
		expect(scheduler.failuresThisTurn).toBe(2);
		scheduler.turnStarted();
		scheduler.turnEnded();
		expect(scheduler.failuresThisTurn).toBe(0);
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

describe("recap policy (Claude Code 2.1.330)", () => {
	it("waits three minutes, capped at 0.8 of the cache lifetime", () => {
		expect(recapDelayMs(180_000, 3_600_000)).toBe(180_000);
		expect(recapDelayMs(180_000, 300_000)).toBe(180_000);
		expect(recapDelayMs(600_000, 300_000)).toBe(240_000);
	});

	it("needs three user turns in all and two since the last recap", () => {
		const marks = (spec: string): BranchMark[] => [...spec].map((c) => (c === "u" ? "user" : c === "r" ? "recap" : undefined));
		expect(enoughUserTurns(marks("u.u"))).toBe(false);
		expect(enoughUserTurns(marks("u.u.u"))).toBe(true);
		expect(enoughUserTurns(marks("uuur"))).toBe(false); // the recap is the last entry
		expect(enoughUserTurns(marks("uuuru."))).toBe(false);
		expect(enoughUserTurns(marks("uuuru.u"))).toBe(true);
	});

	const probe = (over: Partial<RecapProbe> = {}): RecapProbe => ({
		now: 1_000_000,
		lastTurnEndAt: 1_000_000 - 180_000,
		cacheLifetimeMs: 3_600_000,
		rateLimitStatus: undefined,
		draft: "",
		pendingAgents: 0,
		pendingWorkflows: 0,
		wakeupPending: false,
		inFlight: false,
		failuresThisTurn: 0,
		marks: ["user", "user", "user"],
		...over,
	});

	it("runs when nothing holds it back", () => {
		expect(recapSkip(probe())).toBeNull();
		expect(recapSkip(probe({ rateLimitStatus: "allowed" }))).toBeNull();
	});

	it("skips for each of Claude Code's reasons", () => {
		expect(recapSkip(probe({ lastTurnEndAt: undefined }))).toBe("cache_unknown");
		// 0.9 of a five-minute cache is 270 seconds.
		expect(recapSkip(probe({ cacheLifetimeMs: 300_000, lastTurnEndAt: 1_000_000 - 271_000 }))).toBe("cache_stale");
		expect(recapSkip(probe({ cacheLifetimeMs: 300_000, lastTurnEndAt: 1_000_000 - 269_000 }))).toBeNull();
		expect(recapSkip(probe({ rateLimitStatus: "allowed_warning" }))).toBe("near_limit");
		expect(recapSkip(probe({ draft: "half a thought" }))).toBe("draft");
		expect(recapSkip(probe({ pendingAgents: 1 }))).toBe("background_work");
		expect(recapSkip(probe({ pendingWorkflows: 1 }))).toBe("background_work");
		expect(recapSkip(probe({ wakeupPending: true }))).toBe("wakeup");
		expect(recapSkip(probe({ inFlight: true }))).toBe("in_flight");
		expect(recapSkip(probe({ failuresThisTurn: 3 }))).toBe("failing");
		expect(recapSkip(probe({ failuresThisTurn: 2 }))).toBeNull();
		expect(recapSkip(probe({ marks: ["user", "user"] }))).toBe("few_turns");
	});

	it("checks in Claude Code's order: a stale cache wins over everything else", () => {
		expect(recapSkip(probe({ cacheLifetimeMs: 300_000, lastTurnEndAt: 0, draft: "x", pendingAgents: 1, marks: [] }))).toBe("cache_stale");
		expect(recapSkip(probe({ draft: "x", pendingAgents: 1 }))).toBe("draft");
	});
});
