/**
 * The /config panel (pure): its cursor, its keys and its lines. Each change
 * cycles the selected row to its next value; the wiring saves it at once
 * (index.ts). Only width-1 glyphs are drawn, so the column math holds.
 */

import { keyId } from "../../lib/ui/key-input.ts";
import { cutPlainText, padPlainText, panelTopRule, visibleWidth, wrapHints, wrapProse } from "../../lib/ui/tui-render.ts";
import type { ConfigRow } from "../../lib/ui/config-rows.ts";

export interface ConfigPaint {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/** What a key does in the panel. */
export type ConfigKey = "up" | "down" | "change" | "close";

export function decodeConfigKey(data: string): ConfigKey | undefined {
	switch (keyId(data)) {
		case "up":
			return "up";
		case "down":
			return "down";
		case "enter":
		case "space":
			return "change";
		case "escape":
		case "ctrl+c":
			return "close";
		default:
			return undefined;
	}
}

/** The row's next value, wrapping round. */
export function nextValue(row: ConfigRow): string {
	const at = row.values.indexOf(row.currentValue);
	return row.values[(at + 1) % row.values.length];
}

const CONFIG_HINTS = "↑↓ to move · Enter/Space to change · Esc to close";

/** The panel's lines, cut to `width`. `saved` names the settings file; `notice` is the last save's problem, if any. */
export function renderConfig(input: { rows: readonly ConfigRow[]; cursor: number; width: number; saved: string; notice?: string }, paint: ConfigPaint): string[] {
	const { rows, cursor, width } = input;
	const out: string[] = [panelTopRule(paint.fg, width), ` ${paint.bold("Config")}`];
	for (const line of wrapHints(CONFIG_HINTS, Math.max(1, width - 2))) out.push(paint.fg("dim", ` ${line}`));
	out.push(paint.fg("dim", cutPlainText(` Changes are saved to ${input.saved} as you make them.`, width - 1)), "");
	const labelWidth = Math.max(...rows.map((row) => visibleWidth(row.label))) + 2;
	rows.forEach((row, i) => {
		const selected = i === cursor;
		const head = `${selected ? "❯ " : "  "}${padPlainText(row.label, labelWidth)}`;
		const line = cutPlainText(`${head}${row.currentValue}`, width - 1);
		out.push(selected ? paint.fg("accent", line) : `${cutPlainText(head, width - 1)}${paint.fg("muted", cutPlainText(row.currentValue, Math.max(0, width - 1 - visibleWidth(head))))}`);
	});
	const description = rows[cursor]?.description;
	if (description) {
		out.push("");
		for (const line of wrapProse(description, Math.max(1, width - 4))) out.push(paint.fg("dim", `  ${line}`));
	}
	if (input.notice) out.push("", paint.fg("error", cutPlainText(`  ${input.notice}`, width - 1)));
	return out;
}
