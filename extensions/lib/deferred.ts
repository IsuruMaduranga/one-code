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

import { parseClaudeVersion } from "./model-tier.ts";

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

// The one registry instance is constructed by its owner (tool-search/index.ts):
// a shared export here would be a distinct object in every other extension's
// jiti module graph, and a tool deferred through that copy would steer nothing.

/**
 * The every-turn reminder telling the model which tools exist but are not
 * loaded — Claude Code's shape (cc-haiku.json, message 1, block 1): one fixed
 * sentence, then bare names one per line. No descriptions: the model searches
 * by keyword through `tool_search` (which does see descriptions), and a name-
 * only list is ~7x smaller — the description form grew by several KB per MCP
 * server and was the single largest block after `# claudeMd`. The wording is
 * CC's with our tool name and our dispatcher's actual error text; it stays
 * byte-identical after a load (as CC's does) so the cached prefix holds — a
 * loaded tool is simply callable, and the sentence says as much.
 */
export function deferredReminderText(tools: Array<Pick<SearchableTool, "name"> & Partial<SearchableTool>>): string {
	return [
		'The following deferred tools are available via tool_search. Their schemas are NOT loaded — calling one directly fails with "Tool <name> not found" until you load it. Use tool_search with query "select:<name>[,<name>...]" to load tool schemas before calling them (once loaded, a tool stays callable for the rest of the session):',
		...tools.map((t) => t.name),
	].join("\n");
}

/**
 * The one-shot that announces deferred tools which registered AFTER the first
 * request went out (a slow MCP connect, a reconnect, a plugin install). The
 * standing listing on message 1 is frozen once cached (tool-search/announce.ts);
 * this rides the tail instead, so the cached prefix holds.
 */
export function deferredAddendumText(added: readonly string[]): string {
	return [
		"Additional deferred tools became available via tool_search since this conversation started (they registered after the first request). Same rules: load with tool_search \"select:<name>\" before calling.",
		...added,
	].join("\n");
}

/**
 * Whether Anthropic accepts client-side `tool_reference` blocks for this model —
 * pi-ai's `defaultSupportsToolReferences` rule, with the model's own compat flag
 * winning: first-party Anthropic, not Haiku, Claude 4.5 or newer.
 */
export function supportsToolReferences(
	model: { provider?: string; id?: string; compat?: { supportsToolReferences?: boolean } } | undefined,
): boolean {
	if (!model) return false;
	if (typeof model.compat?.supportsToolReferences === "boolean") return model.compat.supportsToolReferences;
	if (model.provider !== "anthropic" || !model.id || model.id.includes("haiku")) return false;
	const version = parseClaudeVersion(model.id);
	return version !== undefined && (version.major > 4 || (version.major === 4 && version.minor >= 5));
}

/** The slice of pi's ToolInfo the deferred definitions need. */
export interface DeferrableToolInfo {
	name: string;
	description?: string;
	parameters?: { properties?: unknown; required?: unknown };
}

/**
 * An Anthropic request with every deferred tool that pi left out appended as a
 * `defer_loading: true` definition, sorted by name (pi's own entries stay first
 * and untouched). Anthropic keeps deferred definitions out of the cached prefix,
 * but ADDING one to `tools` mid-session still re-caches the message history —
 * measured 2026-09-04 on Sonnet 5: the request after a `tool_search` load read
 * only tools + system (8.7k of 25k tokens); with the full deferred set present
 * from request 1 it read all 25k. Unloaded deferred definitions cost no input
 * tokens, so sending them always is free and keeps `tools` byte-stable.
 *
 * Returns undefined (leave the payload alone) when there is nothing to add, the
 * request carries no tools, or the tool names on the wire are not the registry's
 * (pi's OAuth "stealth" mode renames them to Claude Code casing, and a name that
 * cannot be matched must not be duplicated). Schemas follow pi's own
 * `convertTools` shape. Never mutates its input.
 */
export function withDeferredToolDefinitions(
	payload: Record<string, unknown>,
	tools: readonly DeferrableToolInfo[],
	isDeferred: (name: string) => boolean,
): Record<string, unknown> | undefined {
	const existing = payload.tools;
	if (!Array.isArray(existing) || existing.length === 0) return undefined;
	const registry = new Set(tools.map((t) => t.name));
	const present = new Set<string>();
	for (const tool of existing) {
		const name = (tool as { name?: unknown } | null)?.name;
		if (typeof name !== "string" || !registry.has(name)) return undefined;
		present.add(name);
	}
	const extra = tools
		.filter((t) => isDeferred(t.name) && !present.has(t.name))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((t) => ({
			name: t.name,
			description: t.description ?? "",
			input_schema: {
				type: "object",
				properties: t.parameters?.properties ?? {},
				required: t.parameters?.required ?? [],
			},
			defer_loading: true,
		}));
	if (extra.length === 0) return undefined;
	return { ...payload, tools: [...existing, ...extra] };
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
