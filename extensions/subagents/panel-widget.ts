/**
 * The persistent panel below the editor: Claude Code's agent tree PLUS its
 * background-shells chip (shell-panel.ts; Enter on it opens the `/tasks`
 * Background dialog). Mirrors workflow/widget.ts: a component-overload
 * setWidget so rows can right-align against the real width, debounced
 * re-renders, and a 1s ticker to keep elapsed time moving. Also carries both
 * soft-focus states for the down-arrow flow (wired in index.ts): the FIRST ↓
 * lands on the shells chip when shells run, the next ↓ moves into the agent
 * rows.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundTask } from "../background/registry.ts";
import { canShowCustomUi } from "../lib/headless-output.ts";
import type { ShellTaskTracker } from "../lib/shell-tasks.ts";
import { linesComponent, liveUiCtx, safeThemeBold, safeThemeInverse, safeThemePaint } from "../lib/tui-render.ts";
import { buildRows, MAX_STRIP_ROWS, recentlyLeftStrip, renderStrip, TASKS_NOTICE, type PanelRow } from "./panel-render.ts";
import type { LiveRunRegistry } from "./live-runs.ts";
import { renderShellChip, shellRows } from "./shell-panel.ts";

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
	/** Whether the shells chip holds soft focus. */
	shellChipFocused = false;
	/**
	 * The taskId whose transcript is open, or undefined when none is (set by
	 * index.ts). Drives the strip's scroll hints AND pins that run in the strip
	 * so a finished child never drops out from under an open viewer.
	 */
	private viewedId: string | undefined;
	tui: TuiLike | undefined;
	editorBaseline: unknown;
	/**
	 * Set by dispose(). pi replaces the session (and this extension instance) on
	 * /clear, /new and /resume, then invalidates the old ctx: every getter on it
	 * throws. Children killed at that shutdown keep emitting registry changes for
	 * a moment, so schedule()/render() must become no-ops the instant we are
	 * disposed — a timer firing render() against the stale ctx crashed the whole
	 * process (SUBAGENT-REVIEW H1).
	 */
	private disposed = false;
	private readonly unsubscribes: Array<() => void> = [];
	/** The text last sent as an RPC widget; undefined while none is shown. */
	private rpcSent: string | undefined;

	constructor(
		private readonly registry: LiveRunRegistry,
		private readonly getCtx: () => ExtensionContext | undefined,
		private readonly shells?: ShellTaskTracker,
		/** Told the rows this strip paints below the editor (lib/dock-rows.ts). */
		private readonly onRows: (rows: number) => void = () => {},
	) {
		this.unsubscribes.push(registry.subscribe(() => this.schedule()));
		if (shells) this.unsubscribes.push(shells.subscribe(() => this.schedule()));
	}

	/** The ctx to paint on: none once disposed, or once pi has invalidated it (lib/tui-render.ts liveUiCtx). */
	private liveCtx(): ExtensionContext | undefined {
		return this.disposed ? undefined : liveUiCtx(this.getCtx());
	}

	private rows(): PanelRow[] {
		let mainBusy = false;
		try {
			const ctx = this.getCtx();
			mainBusy = ctx ? !ctx.isIdle() : false;
		} catch {
			mainBusy = false;
		}
		return buildRows(this.registry.list(), mainBusy, this.viewedId);
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
	 * the ❯ tracks what is on screen (read-mode actions target the viewed run
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

	// --- The shells chip (Claude Code's ↓-to-manage flow) ---

	/** The shells the chip counts: running, or finished inside the linger window. */
	private shellTasks(): BackgroundTask[] {
		return this.shells ? shellRows(this.shells.list(), Date.now()) : [];
	}

	private runningShellCount(): number {
		return this.shells?.running().length ?? 0;
	}

	/** Whether the chip shows, so ↓ from the editor lands on it first: running
	 * shells, or finished ones still inside the linger window. */
	shellChipAvailable(): boolean {
		return this.shellTasks().length > 0;
	}

	setShellChipFocus(focused: boolean): void {
		this.shellChipFocused = focused;
		this.render();
	}

	/** Lines the chip occupies (for overlay reserve math). */
	shellLineCount(): number {
		return this.shellChipAvailable() ? 1 : 0;
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

	/** Whether dispose() has run (for tests and callers that hold a reference). */
	get isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		if (this.disposed) return;
		// Order matters: the widget is removed through the ctx BEFORE the flag
		// flips (liveCtx() refuses a disposed panel), and the subscriptions go
		// so no later registry/shell event can re-arm a timer.
		const ctx = this.liveCtx();
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.ticker) clearInterval(this.ticker);
		this.timer = this.ticker = undefined;
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		this.onRows(0);
		try {
			ctx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// The ctx went stale between the check and the call; nothing to remove.
		}
	}

	private schedule(): void {
		if (this.disposed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.render();
		}, DEBOUNCE_MS);
		this.timer.unref?.();
	}

	private render(): void {
		const ctx = this.liveCtx();
		if (!ctx) {
			// No live UI to paint (headless, or the session was replaced): stop the
			// ticker too, or it keeps waking a panel nobody can see.
			this.syncTicker(false);
			return;
		}
		const now = Date.now();
		const rows = this.rows();
		const shellTasks = this.shellTasks();
		const shellVisible = shellTasks.length > 0;
		// The chip goes with its last shell: a focus left on it would read "0 shells".
		if (!shellVisible) this.shellChipFocused = false;
		const chipFocused = this.shellChipFocused;
		// The chip is time-invariant while every shell runs (count changes arrive
		// as tracker events), so the clock is needed only while finished shells
		// linger, whose expiry is what clears the chip.
		const lingering = shellTasks.length > this.runningShellCount();
		// A run that just left the strip leaves Claude Code's `/tasks` pointer behind for a moment.
		const notice = rows.length <= 1 && recentlyLeftStrip(this.registry.list(), now, this.viewedId);
		this.syncTicker(rows.length > 1 || notice || lingering);
		// Only the synthetic `main` row exists and no shells → nothing to show yet.
		// Never tear down while a transcript view is open (viewedId set): clearing
		// focus here would orphan the overlay with no key path to close it.
		if (rows.length <= 1 && !shellVisible && !notice && this.viewedId === undefined) {
			this.rpcSent = undefined;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.onRows(0);
			this.focusIndex = undefined;
			this.focusId = undefined;
			return;
		}
		this.anchor(rows);
		const selected = this.focusIndex;
		const showStrip = rows.length > 1;
		// RPC forwards string-array widgets, not component factories or key handlers.
		if (!canShowCustomUi(ctx)) {
			const lines = rows.slice(1, MAX_STRIP_ROWS).map((row) =>
				`${row.run!.name} (${row.run!.taskId}) — ${row.status}: ${row.activity}`,
			);
			if (rows.length > MAX_STRIP_ROWS) lines.push(`${rows.length - MAX_STRIP_ROWS} more agents — /tasks to list all`);
			if (notice) lines.push(TASKS_NOTICE);
			if (shellVisible) lines.push(...shellTasks.map((task) => `${task.id} [shell] ${task.status}: ${task.command ?? task.description}`));
			// The ticker repaints every second; each send is a message to the client.
			const text = lines.join("\n");
			if (text === this.rpcSent) return;
			this.rpcSent = text;
			ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
			this.onRows(0); // no TUI view sizes itself in RPC
			return;
		}
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
					if (showStrip) lines.push(...renderStrip({ rows, selected, viewedId: this.viewedId, width: width - 1, now }, paint));
					else if (notice) lines.push(paint.fg("dim", TASKS_NOTICE));
					if (shellVisible) {
						if (lines.length) lines.push("");
						lines.push(renderShellChip(shellTasks.length, chipFocused, width - 1, paint));
					}
					this.onRows(lines.length);
					return lines.map((line) => ` ${line}`);
				});
			},
			{ placement: "belowEditor" },
		);
	}

	/**
	 * Tick while any child row is shown or a finished shell lingers: elapsed
	 * times move and finished rows expire out of the strip and the chip (linger
	 * windows), without needing another registry event.
	 */
	private syncTicker(active: boolean): void {
		if (active && !this.ticker && !this.disposed) {
			this.ticker = setInterval(() => this.render(), 1000);
			this.ticker.unref?.();
		} else if (!active && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}
}
