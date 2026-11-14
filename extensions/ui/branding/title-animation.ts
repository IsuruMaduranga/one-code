/**
 * The terminal title's leading glyph (pure). Claude Code titles the tab
 * `✳ <title>` and, while a turn runs, swaps the glyph between `⠂` and `⠐`
 * every 960 ms; a prompt waiting for the user (a permission question, a
 * command's panel) holds it on `✳` until it closes.
 *
 * `index.ts` feeds it pi's events (`agent_start`, `agent_settled`,
 * `ui_prompt_start`/`ui_prompt_end`, `session_shutdown`) and writes the title
 * through `ctx.ui.setTitle`. Claude Code also stops the animation while the
 * terminal is not focused; pi gives extensions no focus events (findings §86),
 * so here it runs whenever a turn does.
 */

/** The resting glyph. */
export const TITLE_GLYPH = "✳";
/** The glyphs a working turn alternates between. */
export const TITLE_FRAMES = ["⠂", "⠐"] as const;
/** How long each frame shows. */
export const TITLE_FRAME_MS = 960;

/** The timer and the write the animation drives; `every` returns its own cancel. */
export interface TitleAnimationIo {
	every(ms: number, tick: () => void): () => void;
	write(glyph: string): void;
}

export class TitleAnimation {
	private working = false;
	private prompts = 0;
	private frame = 0;
	private cancel: (() => void) | undefined;

	constructor(private readonly io: TitleAnimationIo) {}

	/** The glyph the title leads with now. */
	get glyph(): string {
		return this.animating ? TITLE_FRAMES[this.frame % TITLE_FRAMES.length] : TITLE_GLYPH;
	}

	private get animating(): boolean {
		return this.working && this.prompts === 0;
	}

	/** A turn started. */
	start(): void {
		this.working = true;
		this.sync();
	}

	/** The run settled: no turn is left. */
	settle(): void {
		this.working = false;
		this.sync();
	}

	/** A prompt now waits for the user. */
	promptOpened(): void {
		this.prompts++;
		this.sync();
	}

	/** A prompt closed. */
	promptClosed(): void {
		this.prompts = Math.max(0, this.prompts - 1);
		this.sync();
	}

	/** The session ended: stop the timer and write nothing more. */
	stop(): void {
		this.cancel?.();
		this.cancel = undefined;
		this.working = false;
		this.prompts = 0;
	}

	private sync(): void {
		if (this.animating && !this.cancel) {
			this.frame = 0;
			this.cancel = this.io.every(TITLE_FRAME_MS, () => {
				this.frame++;
				this.io.write(this.glyph);
			});
		} else if (!this.animating && this.cancel) {
			this.cancel();
			this.cancel = undefined;
		}
		this.io.write(this.glyph);
	}
}
