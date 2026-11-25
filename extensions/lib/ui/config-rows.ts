/**
 * Rows another extension adds to `/config` (commands/config), over the event
 * bus (jiti modules cannot share state). `/config` emits a query; a listener
 * pushes a promise of its row, or of undefined when it has none to show now.
 * The extension that owns a setting keeps its state and its dialogs: the row
 * only names the value and applies a change. Pure: no pi imports.
 */

import { brandedId } from "../profile/brand.mjs";

export const CONFIG_ROWS_CHANNEL = brandedId("config-rows");

/** A row of the /config panel: what it shows, and the values Enter cycles through. */
export interface ConfigRow {
	id: string;
	label: string;
	description: string;
	currentValue: string;
	values: string[];
}

/** A row an extension adds to the panel. */
export interface ContributedConfigRow extends ConfigRow {
	/** True when setting `value` opens a dialog: the panel closes first, since a dialog takes the panel's place. */
	opensDialog?: (value: string) => boolean;
	/** Ask for `value`; resolves to the value now in force (the user may decline in a dialog), or undefined when the row is gone. */
	apply: (value: string) => Promise<string | undefined>;
}

/** The query `/config` emits; `ctx` is the command's context, which a row's dialogs and saves use. */
export interface ConfigRowsQuery {
	ctx: unknown;
	rows: Array<Promise<ContributedConfigRow | undefined>>;
}
