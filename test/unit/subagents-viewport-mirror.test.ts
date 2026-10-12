import { describe, expect, it } from "vitest";
import { asScrollableViewport, ViewportMirror } from "../../extensions/subagents/viewport-mirror.ts";

/** pi-tui's primary scroll view, reduced to what the mirror touches. */
class FakeViewport {
	top: number;
	following = true;
	constructor(
		public content: number,
		public height: number,
	) {
		this.top = this.max();
	}
	max(): number {
		return Math.max(0, this.content - this.height);
	}
	get viewportTop(): number {
		return this.following ? this.max() : this.top;
	}
	get isFollowingOutput(): boolean {
		return this.following;
	}
	scrollBy(lines: number): void {
		const start = this.viewportTop;
		this.top = Math.max(0, Math.min(this.max(), start + lines));
		this.following = this.top === this.max();
	}
	scrollToBottom(): void {
		this.top = this.max();
		this.following = true;
	}
	/** What pi's PageUp/PageDown do (a page less a two-line overlap). */
	page(direction: -1 | 1): void {
		this.scrollBy(direction * (this.height - 2));
	}
}

describe("ViewportMirror", () => {
	it("turns a page up on main into view scroll and parks main again", () => {
		const main = new FakeViewport(500, 30);
		const mirror = new ViewportMirror(main);
		main.page(-1);
		const scroll = mirror.absorb(0, 1000);
		expect(scroll).toBe(28);
		// Parked 28 lines above the bottom so a page down can register.
		expect(main.viewportTop).toBe(main.max() - 28);
		main.page(1);
		expect(mirror.absorb(scroll, 1000)).toBe(0);
		expect(main.isFollowingOutput).toBe(true);
	});

	it("leaves the view alone while main only grows", () => {
		const main = new FakeViewport(100, 30);
		const mirror = new ViewportMirror(main);
		main.content += 40;
		expect(mirror.absorb(5, 100)).toBe(5);
		expect(main.isFollowingOutput).toBe(true);
	});

	it("clamps to the view's own range", () => {
		const main = new FakeViewport(500, 30);
		const mirror = new ViewportMirror(main);
		main.page(-1);
		expect(mirror.absorb(0, 10)).toBe(10);
	});

	it("keeps paging up past one page", () => {
		const main = new FakeViewport(500, 30);
		const mirror = new ViewportMirror(main);
		let scroll = 0;
		for (let i = 0; i < 3; i++) {
			main.page(-1);
			scroll = mirror.absorb(scroll, 1000);
		}
		expect(scroll).toBe(84);
	});

	it("restores main to the bottom when it was following at open", () => {
		const main = new FakeViewport(500, 30);
		const mirror = new ViewportMirror(main);
		main.page(-1);
		mirror.absorb(0, 1000);
		mirror.restore();
		expect(main.isFollowingOutput).toBe(true);
	});

	it("restores main to where the user had scrolled it", () => {
		const main = new FakeViewport(500, 30);
		main.scrollBy(-100);
		const opened = main.viewportTop;
		const mirror = new ViewportMirror(main);
		main.page(-1);
		mirror.absorb(0, 1000);
		mirror.restore();
		expect(main.viewportTop).toBe(opened);
		expect(main.isFollowingOutput).toBe(false);
	});

	it("parks main at the bottom after a retarget resets the view", () => {
		const main = new FakeViewport(500, 30);
		const mirror = new ViewportMirror(main);
		main.page(-1);
		mirror.absorb(0, 1000);
		mirror.park(0);
		expect(main.isFollowingOutput).toBe(true);
		expect(mirror.absorb(0, 1000)).toBe(0);
	});
});

describe("asScrollableViewport", () => {
	it("accepts pi's fullscreen TUI and rejects the regular one", () => {
		expect(asScrollableViewport(new FakeViewport(10, 5))).toBeDefined();
		expect(asScrollableViewport({ terminal: { rows: 30 } })).toBeUndefined();
		expect(asScrollableViewport(undefined)).toBeUndefined();
	});
});
