/**
 * Bounding for text shown in a consent modal (pure).
 *
 * A consent dialog lists what an untrusted repo wants to run — hook commands,
 * MCP server commands. The list must not hide where an attack lives (so a single
 * item is shown in full up to a generous per-item cap, never an 80-char slice),
 * but it also must not render megabytes into a modal (hundreds of items, or one
 * pathologically long one). This bounds the total: full items until a budget,
 * each item capped, then a pointer to the real file (which is the source of
 * truth the user should read before approving anything this large).
 */

const PER_ITEM_CAP = 2000;
const TOTAL_CAP = 4000;

export function boundConsentItems(items: string[], moreHint: string): string {
	const shown: string[] = [];
	let used = 0;
	for (const item of items) {
		const capped = item.length > PER_ITEM_CAP ? `${item.slice(0, PER_ITEM_CAP)}… [truncated, ${item.length} chars]` : item;
		// Always show the first item (so an empty modal never happens); stop once
		// the budget is spent.
		if (shown.length > 0 && used + capped.length + 1 > TOTAL_CAP) break;
		shown.push(capped);
		used += capped.length + 1;
	}
	const hidden = items.length - shown.length;
	const more = hidden > 0 ? `\n… and ${hidden} more not shown — ${moreHint}` : "";
	return shown.join("\n") + more;
}
