/**
 * Viewport mirror for the agent view (pure; no pi imports).
 *
 * In pi's fullscreen mode the terminal's scroll input (PageUp/PageDown, the
 * mouse wheel, Ctrl+Home/Ctrl+End, plain Home/End before pi 1.0.3) is taken
 * by pi-tui's own viewport handler before any extension input listener runs
 * (findings §10), and it scrolls the main transcript. The agent view is an
 * overlay over that transcript, so the user saw nothing move in the view while
 * main, hidden below it, scrolled away and stayed scrolled up after the view
 * closed.
 *
 * The mirror turns those moves into agent-view scrolling, as Claude Code
 * scrolls whatever transcript is on screen: each frame it reads how far the
 * main viewport moved since it was last parked, hands that distance to the
 * view, and parks main again. Main is parked above its bottom by up to the
 * view's own scroll (at most half main's range), so a later move down has room
 * to register too. `restore()` puts main back where it was when the view
 * opened.
 *
 * Only the main transcript's range can register a move: when main is shorter
 * than one screen, the page keys move nothing and the view cannot see them.
 */

/** The slice of pi-tui's fullscreen TUI the mirror drives (structural). */
export interface ScrollableViewport {
	readonly viewportTop: number;
	readonly isFollowingOutput: boolean;
	scrollBy(lines: number): void;
	scrollToBottom(): void;
}

/** The TUI's fullscreen viewport, or undefined in regular (main-screen) mode. */
export function asScrollableViewport(tui: unknown): ScrollableViewport | undefined {
	const candidate = tui as Partial<ScrollableViewport> | undefined;
	if (!candidate || typeof candidate.viewportTop !== "number" || typeof candidate.isFollowingOutput !== "boolean") return undefined;
	if (typeof candidate.scrollBy !== "function" || typeof candidate.scrollToBottom !== "function") return undefined;
	return candidate as ScrollableViewport;
}

export class ViewportMirror {
	private readonly openedFollowing: boolean;
	private readonly openedTop: number;
	private parkedTop: number;
	private parkedAtBottom: boolean;

	constructor(private readonly viewport: ScrollableViewport) {
		this.openedFollowing = viewport.isFollowingOutput;
		this.openedTop = viewport.viewportTop;
		this.parkedTop = this.openedTop;
		this.parkedAtBottom = this.openedFollowing;
	}

	/**
	 * Fold any main-viewport move since the last park into the view's scroll
	 * (lines from the bottom, up is positive) and park main again. Returns the
	 * new scroll, clamped to `[0, maxScroll]`.
	 */
	absorb(scroll: number, maxScroll: number): number {
		const { viewport } = this;
		// Parked at the bottom and still following: main only grew, nobody scrolled.
		if (this.parkedAtBottom && viewport.isFollowingOutput) {
			this.parkedTop = viewport.viewportTop;
			return scroll;
		}
		const top = viewport.viewportTop;
		if (top === this.parkedTop) return scroll;
		const next = clamp(scroll + (this.parkedTop - top), maxScroll);
		this.park(next);
		return next;
	}

	/** Park main for a view scroll of `scroll` lines (after a retarget, say). */
	park(scroll: number): void {
		const { viewport } = this;
		viewport.scrollToBottom();
		const bottom = viewport.viewportTop;
		const lift = Math.min(Math.max(0, scroll), Math.floor(bottom / 2));
		if (lift > 0) viewport.scrollBy(-lift);
		this.parkedTop = viewport.viewportTop;
		this.parkedAtBottom = lift === 0;
	}

	/** Put main back where it was when the view opened. */
	restore(): void {
		const { viewport } = this;
		viewport.scrollToBottom();
		if (this.openedFollowing) return;
		const delta = this.openedTop - viewport.viewportTop;
		if (delta !== 0) viewport.scrollBy(delta);
	}
}

function clamp(value: number, max: number): number {
	return Math.max(0, Math.min(Math.max(0, max), value));
}
