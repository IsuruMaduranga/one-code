/**
 * config extension: `/config`, the settings panel (Claude Code's command of
 * the same name, over One Code's own settings). It lists the optional
 * features a user turns off and the settings One Code keeps in its user
 * settings file, and saves each change the moment it is made, re-reading the
 * file first so a change another session saved is kept. Other extensions
 * add rows for settings they own over CONFIG_ROWS_CHANNEL (the instructions
 * extension's external-includes approval); such a row applies its own change,
 * and the panel closes first when the change opens a dialog.
 *
 * The rows and the rewrite are pure (rows.ts), and so are the panel's keys
 * and lines (panel.ts). The TUI gets the panel; RPC a select dialog of the
 * rows, one change per pick; a run with no UI the values as text.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { feature } from "../../lib/profile/feature.ts";
import { tildify } from "../../lib/profile/paths.ts";
import { activeProfile, toolLive } from "../../lib/profile/profile.ts";
import { productSettingsPath, readSettingsForWrite, writeSettings } from "../../lib/profile/product-settings.ts";
import { CONFIG_ROWS_CHANNEL, type ConfigRow, type ConfigRowsQuery, type ContributedConfigRow } from "../../lib/ui/config-rows.ts";
import { registerLocalCommand } from "../../lib/ui/local-command.ts";
import { panelUi } from "../../lib/ui/panel-focus.ts";
import { linesComponent, safeThemeBold, safeThemePaint } from "../../lib/ui/tui-render.ts";
import { decodeConfigKey, nextValue, renderConfig } from "./panel.ts";
import { configRows, withSetting } from "./rows.ts";

/** A row on the panel: one of /config's own, or one another extension added (it has `apply`). */
type Row = ConfigRow | ContributedConfigRow;
const isContributed = (row: Row): row is ContributedConfigRow => "apply" in row;

function configExtension(pi: ExtensionAPI) {
	// featuresOff ids the profile skipped (lib/profile/profile.ts): said once per process, where the user can fix them.
	let warnedSkipped = false;
	pi.on("session_start", (_event, ctx) => {
		const skipped = activeProfile().settingsOffIgnored;
		if (warnedSkipped || !skipped?.length || !ctx.hasUI) return;
		warnedSkipped = true;
		ctx.ui.notify(`"featuresOff" in ${tildify(productSettingsPath(homedir()), homedir())} skips ${skipped.join(", ")}. Remove them, or change the features in /config.`, "warning");
	});
	registerLocalCommand(pi, "config", {
		description: "Open the settings panel",
		reportsResult: true,
		handler: async (_args, ctx) => {
			const home = homedir();
			const path = productSettingsPath(home);
			const saved = tildify(path, home);
			const read = (): { file: Record<string, unknown> } | { error: string } => {
				try {
					return { file: readSettingsForWrite(path) };
				} catch (error) {
					return { error: `${saved} could not be read: ${(error as Error).message}` };
				}
			};
			const first = read();
			if ("error" in first) {
				ctx.ui.notify(`${first.error}. Fix or remove it, then run /config again.`, "error");
				return "";
			}
			const query: ConfigRowsQuery = { ctx, rows: [] };
			pi.events.emit(CONFIG_ROWS_CHANNEL, query);
			const contributed = (await Promise.all(query.rows.map((row) => row.catch(() => undefined)))).filter((row): row is ContributedConfigRow => row !== undefined);
			const rows: Row[] = [...configRows({ file: first.file, offBy: activeProfile().featuresOffBy, workflows: toolLive("workflow") }), ...contributed];
			if (!ctx.hasUI) return rows.map((row) => `${row.label}: ${row.currentValue}`).join("\n");

			const changes = new Map<string, string>();
			/** Save a row of /config's own; the problem when it could not be saved. */
			const save = (row: Row, value: string): string | undefined => {
				const current = read();
				if ("error" in current) return current.error;
				const next = withSetting(current.file, row.id, value);
				if (!next) return undefined;
				try {
					writeSettings(path, next);
				} catch (error) {
					return `Could not save ${saved}: ${(error as Error).message}`;
				}
				row.currentValue = value;
				changes.set(row.id, `${row.label}: ${value}`);
				return undefined;
			};
			/** Apply a contributed row's change; record it only when the value in force changed. */
			const applyContributed = async (row: ContributedConfigRow, value: string): Promise<string | undefined> => {
				try {
					const before = row.currentValue;
					const now = await row.apply(value);
					if (now !== undefined) {
						row.currentValue = now;
						if (now !== before) changes.set(row.id, `${row.label}: ${now}`);
					}
					return undefined;
				} catch (error) {
					return `Could not change ${row.label}: ${(error as Error).message}`;
				}
			};

			if (ctx.mode === "tui") await runPanel(pi, ctx, rows, saved, save, applyContributed);
			else await runSelect(ctx, rows, save, applyContributed);
			if (changes.size === 0) return "No settings changed";
			return [...changes.values()].join("\n");
		},
	});
}

type Save = (row: Row, value: string) => string | undefined;
type ApplyContributed = (row: ContributedConfigRow, value: string) => Promise<string | undefined>;

/** The TUI panel. A contributed row whose change opens a dialog closes the panel and applies after it. */
async function runPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext, rows: Row[], saved: string, save: Save, applyContributed: ApplyContributed): Promise<void> {
	let deferred: { row: ContributedConfigRow; value: string } | undefined;
	await panelUi(pi.events, ctx.ui).custom<void>((tui, theme, _keybindings, done) => {
		const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };
		let cursor = 0;
		let notice: string | undefined;
		let busy = false;
		const view = linesComponent((width) => renderConfig({ rows, cursor, width, saved, notice }, paint));
		const redraw = () => {
			view.invalidate();
			tui.requestRender();
		};
		return {
			render: (width: number) => view.render(width),
			handleInput: (data: string) => {
				if (busy) return;
				const key = decodeConfigKey(data);
				if (key === "close") return done(undefined);
				if (key === "up") cursor = (cursor + rows.length - 1) % rows.length;
				else if (key === "down") cursor = (cursor + 1) % rows.length;
				else if (key === "change") {
					const row = rows[cursor];
					const value = nextValue(row);
					if (!isContributed(row)) notice = save(row, value);
					else if (row.opensDialog?.(value)) {
						deferred = { row, value };
						return done(undefined);
					} else {
						busy = true;
						void applyContributed(row, value).then((problem) => {
							busy = false;
							notice = problem;
							redraw();
						});
					}
				} else return;
				redraw();
			},
			invalidate: () => view.invalidate(),
		};
	});
	if (deferred) {
		const problem = await applyContributed(deferred.row, deferred.value);
		if (problem) ctx.ui.notify(problem, "error");
	}
}

/** RPC: a select dialog of the rows; each pick changes that row, and the dialog opens again until dismissed. */
async function runSelect(ctx: ExtensionCommandContext, rows: Row[], save: Save, applyContributed: ApplyContributed): Promise<void> {
	for (;;) {
		const options = rows.map((row) => `${row.label}: ${row.currentValue}`);
		const picked = await ctx.ui.select("Config", options);
		const row = picked === undefined ? undefined : rows[options.indexOf(picked)];
		if (!row) return;
		const value = nextValue(row);
		const problem = isContributed(row) ? await applyContributed(row, value) : save(row, value);
		if (problem) ctx.ui.notify(problem, "error");
	}
}

export default feature("config", configExtension);
