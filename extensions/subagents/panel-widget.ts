/**
 * The persistent panel below the editor: Claude Code's agent tree PLUS its
 * background-shell manager (chip → Background list → shell details, rendered
 * by shell-panel.ts). Mirrors workflow/widget.ts: a component-overload
 * setWidget so rows can right-align against the real width, debounced
 * re-renders, and a 1s ticker to keep elapsed time moving. Also carries both
 * soft-focus states for the down-arrow flow (wired in index.ts): the FIRST ↓
 * lands on the shells chip when shells run, the next ↓ moves into the agent
 * rows.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundTask } from "../background/registry.ts";
import type { ShellTaskTracker } from "../lib/shell-tasks.ts";
import { linesComponent, safeThemeBold, safeThemeInverse, safeThemePaint } from "../lib/tui-render.ts";
import { buildRows, MAX_STRIP_ROWS, nextAgentTaskId, renderStrip, type PanelRow } from "./panel-render.ts";
import type { LiveRunRegistry } from "./live-runs.ts";
import {
	anchorShellFocus,
	renderShellSection,
	type ShellFocus,
	shellRows,
	shellSectionVisible,
} from "./shell-panel.ts";

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
	/** The shell-manager side of the panel (chip → list → details). */
	shellFocus: ShellFocus | undefined;
	/**
	 * The taskId whose transcript is open, or undefined when none is (set by
	 * index.ts). Drives the strip's scroll hints AND pins that run in the strip
	 * so a finished child never drops out from under an open viewer.
	 */
	private viewedId: string | undefined;
	tui: TuiLike | undefined;
	editorBaseline: unknown;

	constructor(
		private readonly registry: LiveRunRegistry,
		private readonly getCtx: () => ExtensionContext | undefined,
		private readonly shells?: ShellTaskTracker,
	) {
		registry.subscribe(() => this.schedule());
		shells?.subscribe(() => this.schedule());
	}

	private rows(): PanelRow[] {
		const ctx = this.getCtx();
		let mainBusy = false;
		try {
			mainBusy = ctx ? !ctx.isIdle() : false;
		} catch {
			mainBusy = false;
		}
		return buildRows(this.registry.list(), mainBusy, Date.now(), this.viewedId);
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

	/** index.ts sets the open transcript's taskId (or undefined on close) so the
	 * strip switches to scroll hints and pins that run visible. Also parks the
	 * strip highlight on the viewed run while it is within the visible window, so
	 * the ● tracks what is on screen (read-mode actions target the viewed run
	 * regardless — see selectedRun's window caveat). */
	setView(taskId: string | undefined): void {
		if (this.viewedId === taskId) return;
		this.viewedId = taskId;
		if (taskId !== undefined) {
			const rows = this.rows();
			const idx = rows.findIndex((r) => r.run?.taskId === taskId);
			if (idx >= 0 && idx < Math.min(rows.length, MAX_STRIP_ROWS)) {
				this.focusIndex = idx;
				this.focusId = taskId;
			}
		}
		this.render();
	}

	/** The taskId whose transcript is open (undefined when none). Read-mode
	 * actions (stop, next-agent) anchor to this, not the windowed selection. */
	viewedTaskId(): string | undefined {
		return this.viewedId;
	}

	/** The agent to retarget to on Tab, relative to the viewed run in the FULL
	 * row list (see nextAgentTaskId — avoids the windowed-selection desync). */
	nextAgentAfter(taskId: string | undefined): string | undefined {
		return nextAgentTaskId(this.rows(), taskId);
	}

	// --- Shell-manager state (Claude Code's ↓-to-manage flow) ---

	/** Live shell rows for the list/details views. */
	shellTasks(): BackgroundTask[] {
		return this.shells ? shellRows(this.shells.list(), Date.now()) : [];
	}

	shellIds(): string[] {
		return this.shellTasks().map((t) => t.id);
	}

	private runningShellCount(): number {
		return this.shells?.running().length ?? 0;
	}

	/** Whether ↓ from the editor should land on the chip first — running shells
	 * or finished ones still inside the linger window. */
	shellChipAvailable(): boolean {
		return this.shellTasks().length > 0;
	}

	/** `ids`, when the caller already derived the row order, skips re-deriving it. */
	setShellFocus(focus: ShellFocus | undefined, ids?: string[]): void {
		this.shellFocus = focus && anchorShellFocus(focus, ids ?? this.shellIds());
		this.render();
	}

	/** The anchored current focus (the selected shell may have lingered out). */
	anchoredShellFocus(ids?: string[]): ShellFocus | undefined {
		if (this.shellFocus) this.shellFocus = anchorShellFocus(this.shellFocus, ids ?? this.shellIds());
		return this.shellFocus;
	}

	/** Point lookup — no need for the linger-filtered, sorted row build. */
	shellTaskById(id: string): BackgroundTask | undefined {
		return this.shells?.list().find((t) => t.id === id);
	}

	selectedShellTask(): BackgroundTask | undefined {
		const focus = this.anchoredShellFocus();
		if (!focus || focus.stage === "chip") return undefined;
		return this.shellTaskById(focus.selectedId);
	}

	private shellVisible(): boolean {
		return shellSectionVisible(this.shellTasks().length, this.shellFocus);
	}

	/** Lines the shell section currently occupies (for overlay reserve math) —
	 * measured off the real renderer so layout changes can never desync it. */
	shellLineCount(): number {
		return this.shellVisible() ? this.shellSectionLines(80).length : 0;
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

	/** The shell section's lines; identity paint when only counting. */
	private shellSectionLines(
		width: number,
		paint = { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t },
	): string[] {
		return renderShellSection(
			{
				rows: this.shellTasks(),
				runningCount: this.runningShellCount(),
				focus: this.shellFocus,
				width,
				now: Date.now(),
			},
			paint,
		);
	}

	private render(): void {
		const ctx = this.getCtx();
		if (!ctx?.hasUI) return;
		const rows = this.rows();
		const shellVisible = this.shellVisible();
		// The chip is time-invariant while every shell runs (count changes arrive
		// as tracker events), so the clock is needed only for the list (linger
		// expiry) and details (runtime, live output) stages — or when finished
		// shells are lingering, whose expiry is what hides the section.
		const shellStage = this.shellFocus?.stage;
		const lingering = shellVisible && this.shellTasks().length > this.runningShellCount();
		this.syncTicker(rows.length > 1 || shellStage === "list" || shellStage === "details" || lingering);
		// Only the synthetic `main` row exists and no shells → nothing to show yet.
		// Never tear down while a transcript view is open (viewedId set): clearing
		// focus here would orphan the overlay with no key path to close it.
		if (rows.length <= 1 && !shellVisible && this.viewedId === undefined) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.focusIndex = undefined;
			this.focusId = undefined;
			this.shellFocus = undefined;
			return;
		}
		this.anchor(rows);
		if (this.shellFocus) this.shellFocus = anchorShellFocus(this.shellFocus, this.shellIds());
		const selected = this.focusIndex;
		const showStrip = rows.length > 1;
		const now = Date.now();
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui as TuiLike;
				const focused = (tui as TuiLike).getFocusedComponent?.();
				if (focused && typeof (focused as { getText?: unknown }).getText === "function") {
					this.editorBaseline = focused;
				}
				const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme), inverse: safeThemeInverse(theme) };
				return linesComponent((width) => {
					const lines: string[] = [];
					if (showStrip) lines.push(...renderStrip({ rows, selected, viewOpen: this.viewedId !== undefined, width: width - 1, now }, paint));
					if (shellVisible) {
						if (lines.length) lines.push("");
						lines.push(...this.shellSectionLines(width - 1, paint));
					}
					return lines.map((line) => ` ${line}`);
				});
			},
			{ placement: "belowEditor" },
		);
	}

	/**
	 * Tick while any child row is shown or the shell manager is focused —
	 * elapsed times move, finished rows expire out of the strip/list (linger
	 * windows), and the details view's output box follows the live spool,
	 * all without needing another registry event.
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
