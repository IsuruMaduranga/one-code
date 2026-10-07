/**
 * Shared interactive model picker (pure).
 *
 * Filtering, key decoding, selection movement, and rendering stay free of pi
 * imports so command wiring can own only mutable state and repaint calls.
 */

import { truncateLine } from "./tui-render.ts";
import { keyId, keyText } from "./key-input.ts";

export interface PickerEntry {
	provider: string;
	id: string;
	/** Input price per million tokens, when the catalog carries a usable one. */
	inputPrice?: number;
}

export const pickerSpec = (entry: { provider: string; id: string }): string => `${entry.provider}/${entry.id}`;

/**
 * Rank a query against one spec: 0 prefix, 1 substring, 2 in-order subsequence,
 * undefined no match. Subsequence keeps "haiku45" finding "claude-haiku-4.5"
 * without a fuzzy-match dependency.
 */
export function matchRank(spec: string, query: string): number | undefined {
	const haystack = spec.toLowerCase();
	const needle = query.toLowerCase().replace(/\s+/g, "");
	if (needle.length === 0) return 2;
	if (haystack.startsWith(needle)) return 0;
	if (haystack.includes(needle)) return 1;
	let at = 0;
	for (const char of needle) {
		at = haystack.indexOf(char, at);
		if (at === -1) return undefined;
		at++;
	}
	return 2;
}

/** Filter and rank, preserving catalog order within a rank. */
export function filterEntries<T extends { provider: string; id: string }>(entries: T[], query: string): T[] {
	return entries
		.map((entry, position) => ({ entry, position, rank: matchRank(pickerSpec(entry), query) }))
		.filter((item): item is { entry: T; position: number; rank: number } => item.rank !== undefined)
		.sort((a, b) => a.rank - b.rank || a.position - b.position)
		.map((item) => item.entry);
}

export type PickerKey =
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "backspace" }
	| { kind: "type"; text: string };

/**
 * Decode a raw terminal chunk. Unlike the effort slider there are no letter
 * shortcuts: every printable character belongs to the filter query.
 */
export function decodePickerKey(data: string): PickerKey | undefined {
	switch (keyId(data)) {
		case "up":
			return { kind: "up" };
		case "down":
			return { kind: "down" };
		case "enter":
			return { kind: "confirm" };
		case "escape":
		case "ctrl+c": // same intent as escape while the picker is focused
			return { kind: "cancel" };
		case "backspace":
		case "ctrl+backspace":
			return { kind: "backspace" };
		default: {
			// Printable text only (covers paste); control sequences type nothing.
			const text = keyText(data);
			return text ? { kind: "type", text } : undefined;
		}
	}
}

/** First index of the window shown, keeping the cursor visible. */
export function windowStart(index: number, length: number, maxVisible: number): number {
	if (length <= maxVisible) return 0;
	return Math.max(0, Math.min(index - Math.floor(maxVisible / 2), length - maxVisible));
}

export type Paint = (color: string, text: string) => string;

export interface PickerView {
	entries: PickerEntry[];
	index: number;
	query: string;
	/** Catalog size before filtering, for the "n of m" line. */
	total: number;
	/** The currently configured spec, marked in the listing. */
	current?: string;
	maxVisible?: number;
	/** Picker header and explanatory subtitle. */
	title: string;
	subtitle: string;
}

const formatPrice = (price?: number): string => (price === undefined ? "" : `$${price}/M in`);

/** Picker entries from a model catalog, sorted by spec, non-positive prices treated as unpriced. */
export function toPickerEntries(models: { provider: string; id: string; cost?: { input?: number } }[]): PickerEntry[] {
	return models
		.map((model) => ({
			provider: model.provider,
			id: model.id,
			inputPrice: typeof model.cost?.input === "number" && model.cost.input > 0 ? model.cost.input : undefined,
		}))
		.sort((a, b) => pickerSpec(a).localeCompare(pickerSpec(b)));
}

export interface PickerComponentOptions {
	entries: PickerEntry[];
	current?: string;
	title: string;
	subtitle: string;
}

/**
 * A `ctx.ui.custom` model picker: filter-as-you-type over the entries, enter
 * confirms, esc cancels. Kept here with no pi imports.
 */
export function modelPickerComponent(
	options: PickerComponentOptions,
	tui: { requestRender(): void },
	theme: unknown,
	done: (choice: PickerEntry | null) => void,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	const paint: Paint = (color, text) => {
		const themed = theme as { fg?(c: string, t: string): string } | undefined;
		try {
			return themed?.fg ? themed.fg(color, text) : text;
		} catch {
			return text;
		}
	};
	let query = "";
	let index = 0;
	let filtered = options.entries;
	// pi calls render(width) every frame and the picker repaints per keystroke;
	// memoize by width and clear on any state change so a wide default subtitle
	// (115 columns) never reaches the wire uncut — an overwide line crashes pi
	// in regular TUI mode (TUI-REVIEW H2).
	let cache: { width: number; lines: string[] } | undefined;
	return {
		render: (width: number) => {
			if (cache && cache.width === width) return cache.lines;
			const lines = [
				"",
				...renderModelPicker(
					{
						entries: filtered,
						index,
						query,
						total: options.entries.length,
						current: options.current,
						title: options.title,
						subtitle: options.subtitle,
					},
					paint,
					width,
				),
				"",
			];
			cache = { width, lines };
			return lines;
		},
		handleInput: (data: string) => {
			const key = decodePickerKey(data);
			if (!key) return;
			if (key.kind === "cancel") return done(null);
			if (key.kind === "confirm") return done(filtered[index] ?? null);
			if (key.kind === "up") index = Math.max(0, index - 1);
			else if (key.kind === "down") index = Math.max(0, Math.min(filtered.length - 1, index + 1));
			else {
				query = key.kind === "backspace" ? query.slice(0, -1) : query + key.text;
				filtered = filterEntries(options.entries, query);
				index = 0;
			}
			cache = undefined;
			tui.requestRender();
		},
		invalidate: () => {
			cache = undefined;
		},
	};
}

/** Key hint, kept on its own line so it survives at narrow widths. */
const PICKER_HINT = "type to filter · ↑/↓ · enter · esc";
export function renderModelPicker(view: PickerView, paint: Paint, width = Infinity): string[] {
	const maxVisible = view.maxVisible ?? 10;
	// Every line is cut to `width` — pi-tui crashes the whole app on a rendered
	// line wider than the terminal (TUI-REVIEW H2). The default Infinity leaves
	// lines uncut (truncateLine returns them unchanged) for unit tests.
	const cut = (line: string): string => truncateLine(line, width);
	const lines: string[] = [];
	lines.push(cut(paint("accent", view.title)));
	lines.push(cut(paint("dim", view.subtitle)));
	// The key hint is always its own line, so a narrow terminal never clips the
	// only place the keys are documented.
	lines.push(cut(paint("dim", `  ${PICKER_HINT}`)));
	lines.push(cut(`  filter: ${view.query}${paint("dim", "▏")}`));

	if (view.entries.length === 0) {
		lines.push(cut(paint("warning", "  (no available model matches)")));
		return lines;
	}

	const start = windowStart(view.index, view.entries.length, maxVisible);
	for (const [offset, entry] of view.entries.slice(start, start + maxVisible).entries()) {
		const at = start + offset;
		const spec = pickerSpec(entry);
		const annotations = [view.current === spec ? "✓ current" : "", formatPrice(entry.inputPrice)]
			.filter(Boolean)
			.join("  ");
		const suffix = annotations ? `  ${paint("dim", annotations)}` : "";
		lines.push(cut(at === view.index ? `${paint("accent", `❯ ${spec}`)}${suffix}` : `  ${spec}${suffix}`));
	}
	if (view.entries.length > maxVisible || view.entries.length < view.total) {
		lines.push(cut(paint("dim", `  ${view.entries.length} of ${view.total} models${view.query ? " match" : ""}`)));
	}
	return lines;
}
