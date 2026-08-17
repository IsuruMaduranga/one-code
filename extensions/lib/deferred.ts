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

export const DEFER_CHANNEL = "one-code:defer-tool";

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

/**
 * The every-turn reminder telling the model which tools exist but are not
 * loaded. One line per tool (first description line only), like Claude Code's
 * deferred-tools listing.
 */
export function deferredReminderText(tools: Array<Pick<SearchableTool, "name" | "description">>): string {
	return [
		"The following tools are available but their schemas are NOT loaded, so they cannot be called yet:",
		...tools.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`),
		"",
		"Load one with tool_search before using it — `select:<name>[,<name>]` for exact names, or keywords to search. Once a schema is loaded it stays callable for the rest of the session.",
	].join("\n");
}

/**
 * The bare error pi's core dispatcher returns when the model calls a tool whose
 * schema isn't in the active set — including every deferred tool before
 * `tool_search` loads it (pi-agent-core `prepareToolCall`). The message is
 * `Tool <name> not found`; this recovers `<name>` so a deferred miss can be
 * steered back to `tool_search`. Returns undefined for any other error text.
 */
export function toolNotFoundName(text: string): string | undefined {
	return /^Tool (\S+) not found$/.exec(text.trim())?.[1];
}

/** Flatten a tool result's content blocks to plain text (results are untyped over the bus). */
export function resultText(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
		.join("");
}

/**
 * The one-shot correction that rides in right after a deferred tool's
 * "not found" failure, pointing the model at `tool_search` instead of leaving it
 * to recover from the bare error on its own.
 */
export function deferredMissReminderText(name: string): string {
	return [
		`\`${name}\` is a deferred tool — its schema is not loaded, so that call failed with "Tool ${name} not found".`,
		`Load it first with tool_search (\`select:${name}\`), then reissue the call. It stays callable for the rest of the session once loaded.`,
	].join(" ");
}

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
