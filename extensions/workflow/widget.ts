/**
 * Persistent workflow status strip below the editor (Claude Code's bottom
 * workflow entry): one row per run — marker, name, description, right-aligned
 * live stats — rendered via the component overload of ctx.ui.setWidget so it
 * can right-align against the real width. Re-renders are debounced against
 * chatty fan-outs; a 1s ticker keeps elapsed time moving while a run is live.
 *
 * The strip also carries the soft-focus state for the down-arrow flow (wired
 * in index.ts): `setFocus` highlights a row, and the factory captures the TUI
 * handle + the focused editor component so the input hook can verify the
 * editor really has focus before stealing keys from it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { linesComponent, safeThemeBold, safeThemePaint } from "../lib/tui-render.ts";
import { snapshotRun, type RunHandle, type WorkflowRunManager } from "./run-manager.ts";
import { MAX_STATUS_ROWS, renderStatusRows, type ViewerRunSnapshot } from "./viewer.ts";

const WIDGET_KEY = "workflow";
const DEBOUNCE_MS = 250;

/** The slice of pi-tui's TUI the strip needs (structurally typed, no dep). */
interface TuiLike {
	getFocusedComponent?(): unknown;
}

export class WorkflowWidget {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	/** Soft-focused row index (into the newest-first snapshot list). */
	focusIndex: number | undefined;
	/** Captured from the widget factory; used by the focus wiring in index.ts. */
	tui: TuiLike | undefined;
	/**
	 * The core editor component, captured while it holds focus (duck-typed on
	 * getText — dialogs and selectors don't have it). Identity-compared before
	 * consuming any key, so the strip never steals input from a dialog or a
	 * pop-up editor.
	 */
	editorBaseline: unknown;

	constructor(
		private readonly manager: WorkflowRunManager,
		private readonly getCtx: () => ExtensionContext | undefined,
	) {}

	attach(handle: RunHandle): void {
		handle.on("progress", () => this.schedule());
		handle.on("done", () => this.schedule());
		this.schedule();
	}

	/**
	 * Re-set the widget so it re-inserts below rows other extensions just set
	 * (setWidget order is last-write order); the permission-mode badge triggers
	 * this over the status channel to keep the strip beneath the mode line.
	 */
	refresh(): void {
		this.schedule();
	}

	/** Rows currently selectable (capped like the render). */
	rowCount(): number {
		return Math.min(this.manager.list().length, MAX_STATUS_ROWS);
	}

	selectedRun(): ViewerRunSnapshot | undefined {
		if (this.focusIndex === undefined) return undefined;
		return this.visibleSnapshots()[this.focusIndex];
	}

	/**
	 * Only the runs the strip can display (newest first) — a per-tick render
	 * must not pay to copy every run and agent record of the session.
	 */
	private visibleSnapshots(): ViewerRunSnapshot[] {
		return this.manager.list().slice(-MAX_STATUS_ROWS).map(snapshotRun).reverse();
	}

	setFocus(index: number | undefined): void {
		this.focusIndex = index;
		this.render();
	}

	/** True when the core editor is focused and empty — safe to take the down key. */
	editorFocusedAndIdle(ctx: ExtensionContext): boolean {
		if (!this.tui || !this.editorBaseline) return false;
		if (this.tui.getFocusedComponent?.() !== this.editorBaseline) return false;
		try {
			return ctx.ui.getEditorText().trim() === "";
		} catch {
			return false;
		}
	}

	/** True when the core editor still holds real focus (strip may keep soft focus). */
	editorFocused(): boolean {
		return Boolean(this.tui && this.editorBaseline && this.tui.getFocusedComponent?.() === this.editorBaseline);
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.ticker) clearInterval(this.ticker);
		this.timer = this.ticker = undefined;
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.render();
		}, DEBOUNCE_MS);
		this.timer.unref?.();
	}

	private render(): void {
		const ctx = this.getCtx();
		if (!ctx?.hasUI) return;
		const totalRuns = this.manager.list().length;
		const runs = this.visibleSnapshots();
		this.syncTicker(runs);
		if (!runs.length) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		if (this.focusIndex !== undefined && this.focusIndex >= this.rowCount()) {
			this.focusIndex = Math.max(0, this.rowCount() - 1);
		}
		const selected = this.focusIndex;
		const now = Date.now();
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui as TuiLike;
				const focused = (tui as TuiLike).getFocusedComponent?.();
				if (focused && typeof (focused as { getText?: unknown }).getText === "function") {
					this.editorBaseline = focused;
				}
				const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };
				// One-space indent to align with string-array widgets (pi's Text
				// wraps those with paddingX=1 — the permission-mode badge above).
				return linesComponent((width) =>
					renderStatusRows({ runs, totalRuns, selected, width: width - 1, now }, paint).map((line) => ` ${line}`),
				);
			},
			{ placement: "belowEditor" },
		);
	}

	/** Keep elapsed time ticking while any run is live; stop when none is. */
	private syncTicker(runs: ViewerRunSnapshot[]): void {
		const active = runs.some((run) => run.status === "running");
		if (active && !this.ticker) {
			this.ticker = setInterval(() => this.render(), 1000);
			this.ticker.unref?.();
		} else if (!active && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}
}
