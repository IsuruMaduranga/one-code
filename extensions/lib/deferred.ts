/**
 * Deferred-tool registry — Claude Code's ToolSearch mechanism.
 *
 * Tools registered here stay inactive at session start; the model discovers
 * them with `tool_search`, which activates matches additively so pi can use
 * native deferred loading (Anthropic `defer_loading` / OpenAI `tool_search_call`)
 * and keep the cached prompt prefix intact.
 *
 * Any extension can defer its own tools by emitting on DEFER_CHANNEL with
 * `{ name, keywords? }` while extensions are loading (before session_start).
 */

export const DEFER_CHANNEL = "pincer:defer-tool";

export interface DeferRequest {
	name: string;
	/** Extra search terms beyond the tool's name and description. */
	keywords?: string[];
}

export interface SearchableTool {
	name: string;
	description: string;
	keywords: string[];
}

export class DeferredRegistry {
	private entries = new Map<string, string[]>();

	add(request: DeferRequest): void {
		if (!request?.name) return;
		const existing = this.entries.get(request.name) ?? [];
		this.entries.set(request.name, [...new Set([...existing, ...(request.keywords ?? [])])]);
	}

	get names(): string[] {
		return [...this.entries.keys()];
	}

	keywordsFor(name: string): string[] {
		return this.entries.get(name) ?? [];
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}
}

export const deferredRegistry = new DeferredRegistry();

export interface SearchMatch {
	name: string;
	score: number;
}

/**
 * The exact names a `select:` query asks for (lowercased), or undefined when the
 * query is not a select: query. Lets tool_search report which requested names
 * matched nothing instead of silently dropping them.
 */
export function selectedNames(query: string): string[] | undefined {
	const trimmed = query.trim();
	if (!trimmed.toLowerCase().startsWith("select:")) return undefined;
	return trimmed
		.slice("select:".length)
		.split(",")
		.map((n) => n.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Claude Code's ToolSearch query syntax:
 *   "select:Read,Edit"  — exact names, no scoring
 *   "+slack send"       — require "slack" in the tool name, rank by the rest
 *   "notebook jupyter"  — keyword search over name, description, keywords
 */
export function searchTools(query: string, tools: SearchableTool[], maxResults = 5): SearchMatch[] {
	const trimmed = query.trim();

	const selected = selectedNames(query);
	if (selected) {
		return tools
			.filter((t) => selected.includes(t.name.toLowerCase()))
			.map((t) => ({ name: t.name, score: Number.POSITIVE_INFINITY }));
	}

	const rawTerms = trimmed.toLowerCase().split(/[^a-z0-9_+]+/).filter(Boolean);
	const required = rawTerms.filter((t) => t.startsWith("+")).map((t) => t.slice(1)).filter(Boolean);
	const terms = rawTerms.filter((t) => !t.startsWith("+"));

	const scored = tools
		.filter((t) => required.every((r) => t.name.toLowerCase().includes(r)))
		.map((t) => {
			const haystack = `${t.name} ${t.description} ${t.keywords.join(" ")}`.toLowerCase();
			let score = required.length * 2;
			for (const term of terms) {
				if (t.name.toLowerCase().includes(term)) score += 2;
				else if (haystack.includes(term)) score += 1;
			}
			return { name: t.name, score };
		})
		.filter((m) => m.score > 0);

	return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, maxResults);
}
