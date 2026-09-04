import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPromptIdentity, PrefixWarmGate, prefixWarmKey } from "../../extensions/lib/prefix-warm-gate.ts";

/** Drain the microtask queue (no timers — those are faked), so pending `admit()`s can settle. */
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("PrefixWarmGate", () => {
	let clock = 0;
	beforeEach(() => {
		clock = 0;
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	const gate = (opts: { timeoutMs?: number; warmForMs?: number } = {}) => new PrefixWarmGate({ ...opts, now: () => clock });

	it("admits the first caller at once and holds the rest until the leader streams", async () => {
		const g = gate();
		const lead = await g.admit("explore|anthropic/claude-sonnet-5");
		let secondAdmitted = false;
		let thirdAdmitted = false;
		const second = g.admit("explore|anthropic/claude-sonnet-5").then((r) => {
			secondAdmitted = true;
			return r;
		});
		const third = g.admit("explore|anthropic/claude-sonnet-5").then((r) => {
			thirdAdmitted = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(secondAdmitted).toBe(false);
		expect(thirdAdmitted).toBe(false);
		expect(g.warmingCount).toBe(1);

		lead(true);
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(secondAdmitted).toBe(true);
		expect(thirdAdmitted).toBe(true);
		(await second)(true);
		(await third)(true);
		expect(g.warmingCount).toBe(0);
	});

	it("does not gate different keys against each other", async () => {
		const g = gate();
		await g.admit("explore|m");
		let planAdmitted = false;
		void g.admit("plan|m").then(() => {
			planAdmitted = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(planAdmitted).toBe(true);
	});

	it("passes followers straight through while the key is warm, and gates again once it goes stale", async () => {
		const g = gate({ warmForMs: 1_000 });
		(await g.admit("k"))(true);
		clock = 500;
		let admitted = false;
		void g.admit("k").then(() => {
			admitted = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(admitted).toBe(true);

		clock = 5_000; // past warmForMs: the next caller leads again
		const lead = await g.admit("k");
		let followerAdmitted = false;
		void g.admit("k").then(() => {
			followerAdmitted = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(followerAdmitted).toBe(false);
		lead(true);
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(followerAdmitted).toBe(true);
	});

	it("hands the lead to the next waiter when the leader never streams", async () => {
		const g = gate();
		const lead = await g.admit("k");
		let secondRelease: ((s: boolean) => void) | undefined;
		let thirdAdmitted = false;
		void g.admit("k").then((r) => {
			secondRelease = r;
		});
		void g.admit("k").then(() => {
			thirdAdmitted = true;
		});
		await vi.advanceTimersByTimeAsync(0);

		lead(false); // spawn failed before any stream
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		// One waiter took the lead, the other is still held behind it.
		expect(secondRelease).toBeDefined();
		expect(thirdAdmitted).toBe(false);
		expect(g.warmingCount).toBe(1);
		secondRelease!(true);
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(thirdAdmitted).toBe(true);
	});

	it("releases waiters when the leader is slow past the timeout", async () => {
		const g = gate({ timeoutMs: 1_000 });
		await g.admit("k"); // leader never calls release
		let admitted = false;
		void g.admit("k").then(() => {
			admitted = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(admitted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(admitted).toBe(true);
		expect(g.warmingCount).toBe(0);
	});

	it("admitOnFirstToken releases on the session's first assistant message_start and is safe to release again", async () => {
		const g = gate();
		const listeners: Array<(event: unknown) => void> = [];
		const session = {
			subscribe(listener: (event: unknown) => void) {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
		};
		const leadRelease = await g.admitOnFirstToken("k", session);
		let followerAdmitted = false;
		void g.admit("k").then(() => {
			followerAdmitted = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(followerAdmitted).toBe(false);

		for (const l of [...listeners]) l({ type: "message_start", message: { role: "user" } }); // not the assistant
		await flush();
		expect(followerAdmitted).toBe(false);
		for (const l of [...listeners]) l({ type: "message_start", message: { role: "assistant" } });
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(followerAdmitted).toBe(true);
		expect(listeners).toHaveLength(0); // unsubscribed itself
		leadRelease(false); // the finally-path release: ignored, the stream already released
		expect(g.warmingCount).toBe(0);
	});

	it("release is idempotent", async () => {
		const g = gate();
		const lead = await g.admit("k");
		lead(true);
		lead(false); // ignored: the first call decided
		let admitted = false;
		void g.admit("k").then(() => {
			admitted = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(admitted).toBe(true);
	});
});

describe("gate key", () => {
	it("is one scheme for both fan-out sites: prompt identity | cwd | model spec", () => {
		expect(agentPromptIdentity("explore")).toBe("agent:explore");
		expect(agentPromptIdentity(undefined)).toBe("base");
		expect(prefixWarmKey(agentPromptIdentity("explore"), "/repo", "anthropic/claude-sonnet-5")).toBe(
			"agent:explore|/repo|anthropic/claude-sonnet-5",
		);
		// No resolved model yet: the segment is empty, never "undefined".
		expect(prefixWarmKey("base", "/repo", undefined)).toBe("base|/repo|");
	});
});
