import { describe, expect, it } from "vitest";
import { waitForBackground, yieldEnd, type YieldProbes } from "../../extensions/tools/background/yield-wait.ts";

/** Probes over plain state the test changes as it goes. */
function probes(state: { coalescing?: number; handed?: number; running?: number; message?: boolean; due?: boolean }) {
	const listeners = new Set<() => void>();
	const p: YieldProbes = {
		backlog: () => ({ coalescing: state.coalescing ?? 0, handed: state.handed ?? 0 }),
		running: () => state.running ?? 0,
		userMessageQueued: () => state.message ?? false,
		scheduledDue: () => state.due ?? false,
		onHanded: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return { p, hand: () => [...listeners].forEach((l) => l()), listeners };
}

describe("what ends a yield, in Claude Code 2.1.327's order", () => {
	it("a notification already handed to pi beats everything but an abort", () => {
		const { p } = probes({ handed: 1, message: true, due: true, running: 2 });
		expect(yieldEnd(p, false, false, 0)).toEqual({ kind: "delivered" });
		expect(yieldEnd(p, false, true, 0)).toEqual({ kind: "interrupted" });
	});

	it("then a queued user message, then a due scheduled prompt", () => {
		expect(yieldEnd(probes({ message: true, due: true, running: 1 }).p, false, false, 0)).toEqual({ kind: "message" });
		expect(yieldEnd(probes({ due: true, running: 1 }).p, false, false, 0)).toEqual({ kind: "scheduled" });
	});

	it("nothing running ends it only when no notification is still coalescing", () => {
		expect(yieldEnd(probes({ running: 0 }).p, false, false, 0)).toEqual({ kind: "nothingRunning" });
		// A finished agent whose report sits in the 250 ms window: keep waiting for it to reach pi.
		expect(yieldEnd(probes({ running: 0, coalescing: 1 }).p, false, false, 0)).toBeUndefined();
	});

	it("the cap ends a wait that is still going, with how many tasks still run", () => {
		expect(yieldEnd(probes({ running: 2 }).p, false, false, 59_000, 60_000)).toBeUndefined();
		expect(yieldEnd(probes({ running: 2 }).p, false, false, 60_000, 60_000)).toEqual({ kind: "cap", running: 2 });
	});
});

describe("waitForBackground", () => {
	it("returns at once when there is nothing to wait for, and unsubscribes", async () => {
		const { p, listeners } = probes({});
		await expect(waitForBackground(p, undefined)).resolves.toEqual({ kind: "nothingRunning" });
		expect(listeners.size).toBe(0);
	});

	it("blocks while an agent runs and wakes when its report is handed to pi", async () => {
		const state = { running: 1, coalescing: 0 };
		const { p, hand, listeners } = probes(state);
		let settled = false;
		const wait = waitForBackground(p, undefined).then((end) => {
			settled = true;
			return end;
		});
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(settled).toBe(false);
		// The agent finishes: its report coalesces, then reaches pi.
		state.running = 0;
		state.coalescing = 1;
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(settled).toBe(false);
		hand();
		await expect(wait).resolves.toEqual({ kind: "delivered" });
		expect(listeners.size).toBe(0);
	});

	it("ends on a user message typed while it waits, and on an abort", async () => {
		const state = { running: 1, message: false };
		const { p } = probes(state);
		const wait = waitForBackground(p, undefined);
		setTimeout(() => {
			state.message = true;
		}, 100);
		await expect(wait).resolves.toEqual({ kind: "message" });

		const controller = new AbortController();
		const aborted = waitForBackground(probes({ running: 1 }).p, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await expect(aborted).resolves.toEqual({ kind: "interrupted" });
	});

	it("ends at the cap", async () => {
		let now = 0;
		const wait = waitForBackground(probes({ running: 3 }).p, undefined, 1_000, () => now);
		now = 1_000;
		await expect(wait).resolves.toEqual({ kind: "cap", running: 3 });
	});
});
