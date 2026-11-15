import { describe, expect, it } from "vitest";
import { TITLE_FRAME_MS, TITLE_FRAMES, TITLE_GLYPH, TitleAnimation } from "../../extensions/ui/branding/title-animation.ts";

function harness() {
	const writes: string[] = [];
	let tick: (() => void) | undefined;
	let interval: number | undefined;
	const animation = new TitleAnimation({
		every: (ms, fn) => {
			interval = ms;
			tick = fn;
			return () => {
				tick = undefined;
			};
		},
		write: (glyph) => writes.push(glyph),
	});
	return { animation, writes, tickNow: () => tick?.(), running: () => tick !== undefined, interval: () => interval };
}

describe("TitleAnimation", () => {
	it("rests on ✳", () => {
		expect(harness().animation.glyph).toBe(TITLE_GLYPH);
	});

	it("alternates the two frames every 960 ms while a turn runs, and settles back to ✳", () => {
		const h = harness();
		h.animation.start();
		expect(h.interval()).toBe(TITLE_FRAME_MS);
		h.tickNow();
		h.tickNow();
		h.animation.settle();
		expect(h.writes).toEqual([TITLE_FRAMES[0], TITLE_FRAMES[1], TITLE_FRAMES[0], TITLE_GLYPH]);
		expect(h.running()).toBe(false);
	});

	it("holds ✳ while a prompt waits, then resumes", () => {
		const h = harness();
		h.animation.start();
		h.animation.promptOpened();
		expect(h.animation.glyph).toBe(TITLE_GLYPH);
		expect(h.running()).toBe(false);
		h.animation.promptClosed();
		expect(h.running()).toBe(true);
		expect(h.writes.at(-1)).toBe(TITLE_FRAMES[0]);
	});

	it("does not animate for a prompt opened while idle", () => {
		const h = harness();
		h.animation.promptOpened();
		h.animation.promptClosed();
		expect(h.running()).toBe(false);
		expect(h.writes).toEqual([TITLE_GLYPH, TITLE_GLYPH]);
	});

	it("stops the timer and writes nothing at shutdown", () => {
		const h = harness();
		h.animation.start();
		const before = h.writes.length;
		h.animation.stop();
		expect(h.running()).toBe(false);
		expect(h.writes).toHaveLength(before);
		expect(h.animation.glyph).toBe(TITLE_GLYPH);
	});
});
