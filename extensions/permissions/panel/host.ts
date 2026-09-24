/**
 * Mounts the /permissions panel (`ctx.ui.custom`) over the pure state machine
 * and renderer, and runs its effects through the callbacks the permissions
 * extension passes in: the panel owns no gate state. It resolves when the
 * panel closes, with what the user approved and the rule changes they made;
 * the caller tells the model.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundedDockHeight, safeThemeBold, safeThemeInverse, safeThemePaint } from "../../lib/tui-render.ts";
import { decodePanelKey } from "./keys.ts";
import { type PanelPaint, renderPanel } from "./render.ts";
import { applyPanelKey, initialPanelState, type PanelEffect, type PanelView, type RuleTab } from "./state.ts";

const PANEL_MAX_HEIGHT = 24;

export interface PermissionsPanelHost {
	/** The current rules, denials and save destinations. Rebuilt after every effect. */
	view: () => PanelView;
	/** One dim status line under the tabs. */
	status: () => string | undefined;
	/** Save a rule; returns the change line, or throws with the reason. */
	addRule: (behavior: RuleTab, rule: string, destination: string) => string;
	/** Delete a rule by its row key; returns the change line, or throws with the reason. */
	deleteRule: (behavior: RuleTab, key: string) => string;
}

export interface PermissionsPanelResult {
	/** Denial ids marked approved, retries included. */
	approved: Set<number>;
	/** Denial ids marked for retry. */
	retry: Set<number>;
	/** `Added allow rule X`, `Deleted deny rule Y`, in the order they happened. */
	changes: string[];
}

export async function openPermissionsPanel(ctx: ExtensionContext, host: PermissionsPanelHost): Promise<PermissionsPanelResult> {
	const first = host.view();
	const state = initialPanelState(first.denials.length > 0);
	const changes: string[] = [];

	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
		const paint: PanelPaint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme), inverse: safeThemeInverse(theme) };
		// Rendered lines are cached per width and cleared on every key; the view
		// is rebuilt only when an effect changed the rules underneath it.
		let cache: { width: number; lines: string[] } | undefined;
		let view: PanelView = first;

		const runEffect = (effect: PanelEffect) => {
			if (effect.kind === "close") {
				done(null);
				return;
			}
			try {
				changes.push(effect.kind === "addRule" ? host.addRule(effect.behavior, effect.rule, effect.destination) : host.deleteRule(effect.behavior, effect.key));
			} catch (error) {
				state.notice = (error as Error).message;
			}
			view = host.view();
		};

		return {
			render: (width: number) => {
				if (cache?.width === width) return cache.lines;
				const rows = (tui as { terminal: { rows: number } }).terminal.rows;
				const lines = renderPanel({ state, view, width, height: boundedDockHeight(rows, PANEL_MAX_HEIGHT), status: host.status() }, paint);
				cache = { width, lines };
				return lines;
			},
			handleInput: (data: string) => {
				const key = decodePanelKey(data);
				if (!key) return;
				const effect = applyPanelKey(state, key, view);
				if (effect) runEffect(effect);
				cache = undefined;
				tui.requestRender();
			},
			invalidate: () => {
				cache = undefined;
			},
		};
	});

	return { approved: state.approved, retry: state.retry, changes };
}
