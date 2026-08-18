/**
 * The persistent subagent strip below the editor (Claude Code's agent tree).
 * Mirrors workflow/widget.ts: a component-overload setWidget so rows can
 * right-align against the real width, debounced re-renders, and a 1s ticker to
 * keep elapsed time moving. Also carries the soft-focus state for the
 * down-arrow flow (wired in index.ts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { linesComponent, safeThemeBold, safeThemePaint } from "../lib/tui-render.ts";
import { buildRows, MAX_STRIP_ROWS, renderStrip, type PanelRow } from "./panel-render.ts";
import type { LiveRunRegistry } from "./live-runs.ts";

const WIDGET_KEY = "subagents";
const DEBOUNCE_MS = 200;

interface TuiLike {
	getFocusedComponent?(): unknown;
}

export class SubagentWidget {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	focusIndex: number | undefined;
	/**
	 * The selected row's identity — "main" or a run's taskId. Rows shift as
	 * runs register (newest-first) and expire (linger), so every read
	 * re-anchors focusIndex to this id; Enter/x then act on the run the user
	 * actually selected, never on whatever slid into its slot.
	 */
	private focusId: string | undefined;
	tui: TuiLike | undefined;
	editorBaseline: unknown;

	constructor(
		private readonly registry: LiveRunRegistry,
		private readonly getCtx: () => ExtensionContext | undefined,
	) {
		registry.subscribe(() => this.schedule());
	}

	private rows(): PanelRow[] {
		const ctx = this.getCtx();
		let mainBusy = false;
		try {
			mainBusy = ctx ? !ctx.isIdle() : false;
		} catch {
			mainBusy = false;
		}
		return buildRows(this.registry.list(), mainBusy, Date.now());
	}

	rowCount(): number {
		return Math.min(this.rows().length, MAX_STRIP_ROWS);
	}

	/** The focused row's run (undefined for the `main` row or when unfocused). */
	selectedRun() {
		if (this.focusIndex === undefined) return undefined;
		const rows = this.rows();
		this.anchor(rows);
		return this.focusIndex === undefined ? undefined : rows[this.focusIndex]?.run;
	}

	setFocus(index: number | undefined): void {
		this.focusIndex = index;
		this.focusId = index === undefined ? undefined : (this.rows()[index]?.run?.taskId ?? "main");
		this.render();
	}

	/** Re-derive focusIndex from focusId against the given rows (see focusId doc). */
	private anchor(rows: PanelRow[]): void {
		if (this.focusIndex === undefined || this.focusId === undefined) return;
		const shown = Math.min(rows.length, MAX_STRIP_ROWS);
		const idx = this.focusId === "main" ? 0 : rows.findIndex((r) => r.run?.taskId === this.focusId);
		if (idx >= 0 && idx < shown) {
			this.focusIndex = idx;
		} else {
			// The selected run left the strip — fall back to the nearest row.
			this.focusIndex = Math.max(0, Math.min(this.focusIndex, shown - 1));
			this.focusId = rows[this.focusIndex]?.run?.taskId ?? "main";
		}
	}

	editorFocused(): boolean {
		return Boolean(this.tui && this.editorBaseline && this.tui.getFocusedComponent?.() === this.editorBaseline);
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.ticker) clearInterval(this.ticker);
		this.timer = this.ticker = undefined;
		const ctx = this.getCtx();
		if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
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
		const rows = this.rows();
		this.syncTicker(rows.length > 1);
		// Only the synthetic `main` row exists → nothing to show yet.
		if (rows.length <= 1) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.focusIndex = undefined;
			this.focusId = undefined;
			return;
		}
		this.anchor(rows);
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
				return linesComponent((width) =>
					renderStrip({ rows, selected, width: width - 1, now }, paint).map((line) => ` ${line}`),
				);
			},
			{ placement: "belowEditor" },
		);
	}

	/**
	 * Tick while any child row is shown — elapsed times move, and a finished
	 * row expires out of the strip (buildRows' linger window) without needing
	 * another registry event.
	 */
	private syncTicker(active: boolean): void {
		if (active && !this.ticker) {
			this.ticker = setInterval(() => this.render(), 1000);
			this.ticker.unref?.();
		} else if (!active && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}
}
