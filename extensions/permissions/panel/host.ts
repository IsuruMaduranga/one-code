/**
 * Mounts the /permissions panel (`ctx.ui.custom`) over the pure state machine
 * and renderer, and runs its effects through the callbacks the permissions
 * extension passes in: the panel owns no gate state. It resolves when the
 * panel closes, with what the user approved and the changes they made; the
 * caller tells the model.
 *
 * Editing the environment needs pi's multi-line editor, which cannot open over
 * a custom component, so that effect closes the panel with `editEnvironment`
 * set. The caller runs the editor and reopens the panel with the same state
 * and change list, so approvals and the tab survive the round trip.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundedDockHeight, safeThemeBold, safeThemeInverse, safeThemePaint } from "../../lib/tui-render.ts";
import { decodePanelKey } from "./keys.ts";
import { type PanelPaint, renderPanel } from "./render.ts";
import { type AutoSection, applyPanelKey, initialPanelState, type PanelEffect, type PanelState, type PanelView, type RuleTab } from "./state.ts";

const PANEL_MAX_HEIGHT = 24;

/** The panel's I/O. Each change callback returns its change line, or throws with the reason. */
export interface PermissionsPanelHost {
	/** The current rules, denials and save destinations. Rebuilt after every effect. */
	view: () => PanelView;
	/** One dim status line under the tabs. */
	status: () => string | undefined;
	addRule: (behavior: RuleTab, rule: string, destination: string) => string;
	/** Delete a rule by its row key. */
	deleteRule: (behavior: RuleTab, key: string) => string;
	addAutoRule: (section: AutoSection, text: string) => string;
	/** Replace an auto-mode entry, by its row key. */
	editAutoRule: (key: string, text: string) => string;
	deleteAutoRule: (key: string) => string;
}

export interface PermissionsPanelSession {
	state: PanelState;
	/** `Added allow rule X`, `Deleted deny rule Y`, in the order they happened. */
	changes: string[];
	/** Set when the panel closed so the caller can open the environment editor. */
	editEnvironment?: boolean;
}

/** Open the panel. Pass the previous session to reopen it where it was. */
export async function openPermissionsPanel(ctx: ExtensionContext, host: PermissionsPanelHost, previous?: PermissionsPanelSession): Promise<PermissionsPanelSession> {
	const first = host.view();
	const session: PermissionsPanelSession = { state: previous?.state ?? initialPanelState(first.denials.length > 0), changes: previous?.changes ?? [] };
	const { state, changes } = session;

	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
		const paint: PanelPaint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme), inverse: safeThemeInverse(theme) };
		// Rendered lines are cached per width and cleared on every key; the view
		// is rebuilt only when an effect changed the rules underneath it.
		let cache: { width: number; lines: string[] } | undefined;
		let view: PanelView = first;

		const change = (effect: Exclude<PanelEffect, { kind: "close" } | { kind: "editEnvironment" }>): string => {
			switch (effect.kind) {
				case "addRule":
					return host.addRule(effect.behavior, effect.rule, effect.destination);
				case "deleteRule":
					return host.deleteRule(effect.behavior, effect.key);
				case "addAutoRule":
					return host.addAutoRule(effect.section, effect.text);
				case "editAutoRule":
					return host.editAutoRule(effect.key, effect.text);
				case "deleteAutoRule":
					return host.deleteAutoRule(effect.key);
			}
		};

		const runEffect = (effect: PanelEffect) => {
			if (effect.kind === "close" || effect.kind === "editEnvironment") {
				session.editEnvironment = effect.kind === "editEnvironment";
				done(null);
				return;
			}
			try {
				changes.push(change(effect));
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

	return session;
}
