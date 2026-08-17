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
	tui: TuiLike | undefined;
	editorBaseline: unknown;

	constructor(
		private readonly registry: LiveRunRegistry,
		private readonly getCtx: () => ExtensionContext | undefined,
	) {
		registry.subscribe(() => this.schedule());
	}

	/** Re-set to re-insert below rows other extensions just set (last-write order). */
	refresh(): void {
		this.schedule();
	}

	private rows(): PanelRow[] {
		const ctx = this.getCtx();
		let mainBusy = false;
		try {
			mainBusy = ctx ? !ctx.isIdle() : false;
		} catch {
			mainBusy = false;
		}
		return buildRows(this.registry.list(), mainBusy);
	}

	rowCount(): number {
		return Math.min(this.rows().length, MAX_STRIP_ROWS);
	}

	/** The focused row's run (undefined for the `main` row or when unfocused). */
	selectedRun() {
		if (this.focusIndex === undefined) return undefined;
		return this.rows()[this.focusIndex]?.run;
	}

	isMainSelected(): boolean {
		return this.focusIndex !== undefined && !this.rows()[this.focusIndex]?.run;
	}

	setFocus(index: number | undefined): void {
		this.focusIndex = index;
		this.render();
	}

	editorFocusedAndIdle(ctx: ExtensionContext): boolean {
		if (!this.editorFocused()) return false;
		try {
			return ctx.ui.getEditorText().trim() === "";
		} catch {
			return false;
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
		this.syncTicker();
		// Only the synthetic `main` row exists → nothing to show yet.
		if (rows.length <= 1) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.focusIndex = undefined;
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
				return linesComponent((width) =>
					renderStrip({ rows, selected, width: width - 1, now }, paint).map((line) => ` ${line}`),
				);
			},
			{ placement: "belowEditor" },
		);
	}

	private syncTicker(): void {
		const active = this.registry.anyRunning();
		if (active && !this.ticker) {
			this.ticker = setInterval(() => this.render(), 1000);
			this.ticker.unref?.();
		} else if (!active && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}
}
