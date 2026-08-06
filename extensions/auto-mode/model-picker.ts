/**
 * The `/auto-mode model` picker (pure).
 *
 * Filtering, key decoding, selection movement, and rendering for the
 * interactive classifier-model picker, kept free of pi imports so they are
 * unit-testable. The thin `ctx.ui.custom` component in the permissions
 * extension owns nothing but mutable state and repaint calls.
 *
 * A picker exists because the alternative was worse in practice: choosing the
 * classifier automatically took three rounds of fault-fixing against real
 * catalogs, and when auto-selection picks badly the only recourse was
 * hand-editing settings.json with a model id the user has to guess. Naming a
 * model here is the explicit consent `autoMode.classifierModel` stands for —
 * including consent to another provider, which auto-selection must never
 * assume (see model-select.ts).
 */

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
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
			return { kind: "down" };
		case "\r":
		case "\n":
			return { kind: "confirm" };
		case "\x1b":
		case "\x03": // ctrl+c — same intent as escape while the picker is focused
			return { kind: "cancel" };
		case "\x7f":
		case "\b":
			return { kind: "backspace" };
		default: {
			// Printable text only (covers paste); control sequences are ignored.
			const text = [...data].filter((char) => char >= " " && char !== "\x7f").join("");
			return text.length > 0 && !data.startsWith("\x1b") ? { kind: "type", text } : undefined;
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
}

const formatPrice = (price?: number): string => (price === undefined ? "" : `$${price}/M in`);

export function renderModelPicker(view: PickerView, paint: Paint): string[] {
	const maxVisible = view.maxVisible ?? 10;
	const lines: string[] = [];
	lines.push(paint("accent", "Select the auto-mode classifier model"));
	lines.push(
		paint(
			"dim",
			"It reads your prompts and CLAUDE.md — picking another provider sends them there. type to filter · ↑/↓ · enter · esc",
		),
	);
	lines.push(`  filter: ${view.query}${paint("dim", "▏")}`);

	if (view.entries.length === 0) {
		lines.push(paint("warning", "  (no available model matches)"));
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
		lines.push(at === view.index ? `${paint("accent", `❯ ${spec}`)}${suffix}` : `  ${spec}${suffix}`);
	}
	if (view.entries.length > maxVisible || view.entries.length < view.total) {
		lines.push(paint("dim", `  ${view.entries.length} of ${view.total} models${view.query ? " match" : ""}`));
	}
	return lines;
}
