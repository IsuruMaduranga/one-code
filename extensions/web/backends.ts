/**
 * Third-party search backends for `web_search` (pure — no pi imports).
 *
 * `pi-web-search` only speaks the model provider's *own* search API, so on any
 * provider without one (every `openai-completions` model: OpenRouter, Z.ai,
 * Copilot chat, Ollama, DeepSeek direct) `web_search` used to fail outright.
 * This module is the fallback chain that runs there: Brave and Tavily when the
 * user has a key, else Exa's keyless hosted MCP endpoint, which is rate-limited
 * and best-effort and is therefore always labelled as such in the result (and,
 * once per session, to the user — index.ts). Findings §12 has the survey that
 * picked these three and the live probes behind the "keyless" claim.
 *
 * Every backend takes `fetch` as a parameter so the chain is unit-testable
 * without the network; nothing here reads the environment or the file system
 * directly — `resolveChain` is handed `env` and the parsed settings.
 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface DomainFilters {
	allowed?: string[];
	blocked?: string[];
}

export type BackendName = "brave" | "tavily" | "exa-free";

export interface SearchBackend {
	readonly name: BackendName;
	readonly label: string;
	/** True for the keyless route — the result carries the free-tier warning. */
	readonly keyless: boolean;
	search(
		query: string,
		filters: DomainFilters,
		maxResults: number,
		signal: AbortSignal | undefined,
	): Promise<SearchResult[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `webSearch` block of `~/.onecode/settings.json` (One Code's own key). */
export interface WebSearchSettings {
	/** Backend order, e.g. `["tavily", "brave", "exa-free"]`. Unknown names are ignored. */
	order?: BackendName[];
	apiKeys?: { brave?: string; tavily?: string };
}

export const BRAVE_KEY_ENV = "BRAVE_SEARCH_API_KEY";
export const TAVILY_KEY_ENV = "TAVILY_API_KEY";
export const DEFAULT_MAX_RESULTS = 10;
export const BACKEND_TIMEOUT_MS = 30_000;

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_URL = "https://api.tavily.com/search";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const BACKEND_NAMES: readonly BackendName[] = ["brave", "tavily", "exa-free"];

/** The one-line settings snippet both warnings point at: the fix, spelled out. */
export const SETTINGS_SNIPPET = '{ "webSearch": { "apiKeys": { "brave": "<key>" } } }';
export const SETTINGS_FILE = "~/.onecode/settings.json";
/** The advice both warnings share: where a key goes and that the keyed backends have free tiers. */
const KEYLESS_ADVICE =
	`add ${SETTINGS_SNIPPET} (or "tavily") to ${SETTINGS_FILE}, or set ${BRAVE_KEY_ENV} / ${TAVILY_KEY_ENV} in the environment. ` +
	"Brave and Tavily both have free tiers.";

/**
 * Model-facing warning attached to every keyless result: the model should know
 * these results are best-effort and what the user can configure instead.
 */
export const KEYLESS_NOTE =
	"Note: these results came from Exa's free keyless endpoint (rate-limited, best-effort) because no search API key is configured. " +
	`For reliable search the user can ${KEYLESS_ADVICE}`;

/** User-facing one-time notice (TUI) the first time a session searches keyless. */
export const KEYLESS_USER_NOTICE =
	"web_search used Exa's free keyless endpoint (rate-limited, best-effort): this provider has no native web search and no search API key is configured. " +
	`For reliable results ${KEYLESS_ADVICE}`;

// ---------------------------------------------------------------------------
// Settings + chain resolution
// ---------------------------------------------------------------------------

/** Parse the `webSearch` value of a settings file leniently: bad shapes become an empty setting, never a throw. */
export function webSearchSettingsFrom(raw: unknown): WebSearchSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const value = raw as Record<string, unknown>;
	const settings: WebSearchSettings = {};
	if (Array.isArray(value.order)) {
		const order = value.order.filter((n): n is BackendName => typeof n === "string" && (BACKEND_NAMES as string[]).includes(n));
		if (order.length) settings.order = order;
	}
	if (value.apiKeys && typeof value.apiKeys === "object" && !Array.isArray(value.apiKeys)) {
		const keys = value.apiKeys as Record<string, unknown>;
		const apiKeys: WebSearchSettings["apiKeys"] = {};
		if (typeof keys.brave === "string" && keys.brave.trim()) apiKeys.brave = keys.brave.trim();
		if (typeof keys.tavily === "string" && keys.tavily.trim()) apiKeys.tavily = keys.tavily.trim();
		if (Object.keys(apiKeys).length) settings.apiKeys = apiKeys;
	}
	return settings;
}

/**
 * The backends that can run right now, in order. Env vars win over settings
 * keys (the ecosystem-wide convention). Default order: keyed backends first
 * (Brave, then Tavily), keyless Exa last — a configured key means the user
 * chose reliability, so the free route is only ever the last resort. A settings
 * `order` reorders the *available* backends; a keyed backend named there
 * without a key is skipped, and anything not named keeps its default place
 * after the named ones.
 */
export function resolveChain(
	env: Record<string, string | undefined>,
	settings: WebSearchSettings,
	fetchImpl: FetchLike = globalThis.fetch,
): SearchBackend[] {
	const braveKey = env[BRAVE_KEY_ENV]?.trim() || settings.apiKeys?.brave;
	const tavilyKey = env[TAVILY_KEY_ENV]?.trim() || settings.apiKeys?.tavily;
	const available = new Map<BackendName, SearchBackend>();
	if (braveKey) available.set("brave", braveBackend(braveKey, fetchImpl));
	if (tavilyKey) available.set("tavily", tavilyBackend(tavilyKey, fetchImpl));
	available.set("exa-free", exaFreeBackend(fetchImpl));

	const order = [...(settings.order ?? []), ...BACKEND_NAMES];
	const chain: SearchBackend[] = [];
	for (const name of order) {
		const backend = available.get(name);
		if (backend && !chain.includes(backend)) chain.push(backend);
	}
	return chain;
}

// ---------------------------------------------------------------------------
// Domain filters (Claude Code's allowed_domains / blocked_domains)
// ---------------------------------------------------------------------------

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function normalizeDomain(domain: string): string {
	return domain
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/.*$/, "");
}

function hostMatches(host: string, domain: string): boolean {
	const bare = host.replace(/^www\./, "");
	return bare === domain || bare.endsWith(`.${domain}`);
}

function normalizedDomains(list: string[] | undefined): string[] {
	return (list ?? []).map(normalizeDomain).filter(Boolean);
}

/** Keep results whose host is under an allowed domain (when any are given) and under no blocked domain. */
export function filterByDomains(results: SearchResult[], filters: DomainFilters): SearchResult[] {
	const allowed = normalizedDomains(filters.allowed);
	const blocked = normalizedDomains(filters.blocked);
	if (!allowed.length && !blocked.length) return results;
	return results.filter((result) => {
		const host = hostOf(result.url);
		if (!host) return false;
		if (blocked.some((d) => hostMatches(host, d))) return false;
		return !allowed.length || allowed.some((d) => hostMatches(host, d));
	});
}

/**
 * Express the filters as `site:` operators for engines that take them in the
 * query (Brave, and the provider-native path, which has no filter parameters
 * of its own). Post-filtering still applies afterwards — the operators only
 * make the engine return relevant pages instead of pages we then drop.
 */
export function withSiteOperators(query: string, filters: DomainFilters): string {
	const allowed = normalizedDomains(filters.allowed);
	const blocked = normalizedDomains(filters.blocked);
	const parts = [query.trim()];
	if (allowed.length === 1) parts.push(`site:${allowed[0]}`);
	else if (allowed.length > 1) parts.push(`(${allowed.map((d) => `site:${d}`).join(" OR ")})`);
	for (const domain of blocked) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(BACKEND_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The error body, whole: it lands in the tool result, which the caller persists when large (never a bare slice). */
async function errorBody(response: Response): Promise<string> {
	try {
		const text = (await response.text()).trim();
		return text ? `: ${text}` : "";
	} catch {
		return "";
	}
}

/** Throw a labelled error for a failed keyed-API response; 401/403 name the env var to check. */
async function assertOk(response: Response, apiName: string, keyEnv: string): Promise<void> {
	if (response.ok) return;
	const hint = response.status === 401 || response.status === 403 ? ` (check ${keyEnv})` : "";
	throw new Error(`${apiName} HTTP ${response.status}${hint}${await errorBody(response)}`);
}

/** Map a provider's rows onto SearchResult, reading the snippet from `snippetKey`; rows without a url are dropped. */
function toResults(rows: unknown, snippetKey: string): SearchResult[] {
	if (!Array.isArray(rows)) return [];
	return (rows as Array<Record<string, unknown>>)
		.map((r) => ({
			title: typeof r.title === "string" ? r.title : "",
			url: typeof r.url === "string" ? r.url : "",
			snippet: typeof r[snippetKey] === "string" ? (r[snippetKey] as string) : "",
		}))
		.filter((r) => r.url);
}

/** Brave Search API — `X-Subscription-Token`; `web.results[]` of title/url/description. */
export function parseBrave(body: unknown): SearchResult[] {
	return toResults((body as { web?: { results?: unknown } } | undefined)?.web?.results, "description");
}

export function braveBackend(apiKey: string, fetchImpl: FetchLike): SearchBackend {
	return {
		name: "brave",
		label: "Brave Search",
		keyless: false,
		async search(query, filters, maxResults, signal) {
			const url = new URL(BRAVE_URL);
			url.searchParams.set("q", withSiteOperators(query, filters));
			url.searchParams.set("count", String(Math.min(maxResults, 20)));
			const response = await fetchImpl(url.toString(), {
				headers: { accept: "application/json", "x-subscription-token": apiKey },
				signal: timeoutSignal(signal),
			});
			await assertOk(response, "Brave Search API", BRAVE_KEY_ENV);
			return filterByDomains(parseBrave(await response.json()), filters);
		},
	};
}

/** Tavily — Bearer key; `results[]` of title/url/content, native include/exclude domains. */
export function parseTavily(body: unknown): SearchResult[] {
	return toResults((body as { results?: unknown } | undefined)?.results, "content");
}

export function tavilyBackend(apiKey: string, fetchImpl: FetchLike): SearchBackend {
	return {
		name: "tavily",
		label: "Tavily",
		keyless: false,
		async search(query, filters, maxResults, signal) {
			const body: Record<string, unknown> = { query, max_results: Math.min(maxResults, 20) };
			if (filters.allowed?.length) body.include_domains = normalizedDomains(filters.allowed);
			if (filters.blocked?.length) body.exclude_domains = normalizedDomains(filters.blocked);
			const response = await fetchImpl(TAVILY_URL, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(body),
				signal: timeoutSignal(signal),
			});
			await assertOk(response, "Tavily API", TAVILY_KEY_ENV);
			return filterByDomains(parseTavily(await response.json()), filters);
		},
	};
}

/**
 * Exa's hosted MCP server, keyless. One JSON-RPC `tools/call` of `web_search_exa`
 * (no `initialize` handshake needed — verified live 2026-09-09); the reply is
 * either JSON or a one-message SSE stream, and the tool's text is a list of
 * blocks separated by `---`:
 *
 *   Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights:\n…
 */
export function parseExaMcpText(text: string): SearchResult[] {
	const results: SearchResult[] = [];
	for (const block of text.split(/\n\s*---\s*\n/)) {
		const title = block.match(/^Title:\s*(.*)$/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL:\s*(\S+)/m)?.[1]?.trim() ?? "";
		if (!url) continue;
		const highlights = block.split(/^Highlights:\s*$/m)[1] ?? "";
		const snippet = highlights
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && line !== "...")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		results.push({ title, url, snippet });
	}
	return results;
}

/** The JSON-RPC message out of an MCP response body (plain JSON, or the last `data:` line of SSE). */
export function parseMcpResponseBody(body: string, contentType: string): unknown {
	const trimmed = body.trim();
	if (!contentType.includes("text/event-stream")) return JSON.parse(trimmed);
	const dataLines = trimmed
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean);
	if (!dataLines.length) throw new Error("Exa MCP returned an event stream with no data");
	return JSON.parse(dataLines[dataLines.length - 1]);
}

export function exaFreeBackend(fetchImpl: FetchLike): SearchBackend {
	let nextId = 1;
	return {
		name: "exa-free",
		label: "Exa (free keyless endpoint)",
		keyless: true,
		async search(query, filters, maxResults, signal) {
			const response = await fetchImpl(EXA_MCP_URL, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: nextId++,
					method: "tools/call",
					params: { name: "web_search_exa", arguments: { query, numResults: Math.min(maxResults, 20) } },
				}),
				signal: timeoutSignal(signal),
			});
			if (response.status === 429) {
				throw new Error("Exa free endpoint rate-limited the request (HTTP 429); retry shortly or configure a keyed backend");
			}
			if (!response.ok) throw new Error(`Exa MCP HTTP ${response.status}${await errorBody(response)}`);
			const message = parseMcpResponseBody(await response.text(), response.headers.get("content-type") ?? "") as {
				error?: { message?: string };
				result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
			};
			if (message.error) throw new Error(`Exa MCP error: ${message.error.message ?? JSON.stringify(message.error)}`);
			const text = (message.result?.content ?? [])
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text as string)
				.join("\n");
			if (message.result?.isError) throw new Error(`Exa MCP tool error: ${text || "(no detail)"}`);
			return filterByDomains(parseExaMcpText(text), filters);
		},
	};
}

// ---------------------------------------------------------------------------
// Chain execution + result text
// ---------------------------------------------------------------------------

export interface ChainOutcome {
	backend: SearchBackend;
	results: SearchResult[];
	/** `label: error` for every backend tried before this one. */
	failures: string[];
}

/**
 * Try each backend in order until one returns; a backend that throws is
 * recorded and the next one runs. A cancellation stops the whole chain. When
 * every backend fails the error names each attempt so the fix is visible.
 */
export async function runChain(
	chain: SearchBackend[],
	query: string,
	filters: DomainFilters,
	maxResults: number,
	signal: AbortSignal | undefined,
): Promise<ChainOutcome> {
	const failures: string[] = [];
	for (const backend of chain) {
		if (signal?.aborted) throw new Error("Search was cancelled.");
		try {
			const results = await backend.search(query, filters, maxResults, signal);
			return { backend, results, failures };
		} catch (error) {
			if (signal?.aborted) throw new Error("Search was cancelled.");
			failures.push(`${backend.label}: ${(error as Error).message}`);
		}
	}
	throw new Error(`Every search backend failed:\n- ${failures.join("\n- ")}`);
}

/**
 * Claude Code's WebSearch returns "result blocks with titles and URLs"; this is
 * that shape, with the backend named so the model can report its source and,
 * on the keyless route, the configuration note.
 */
export function formatSearchResults(query: string, outcome: ChainOutcome): string {
	const lines: string[] = [];
	lines.push(`Search results for "${query}" (via ${outcome.backend.label}):`);
	if (outcome.failures.length) lines.push(`Fell back after: ${outcome.failures.join("; ")}`);
	if (outcome.backend.keyless) lines.push(KEYLESS_NOTE);
	lines.push("");
	if (!outcome.results.length) {
		lines.push("No results.");
	} else {
		outcome.results.forEach((result, index) => {
			lines.push(`${index + 1}. ${result.title || result.url}`);
			lines.push(`   ${result.url}`);
			if (result.snippet) lines.push(`   ${result.snippet}`);
			lines.push("");
		});
		lines.push('After answering from these results, end with a "Sources:" list of the URLs you used as markdown links.');
	}
	return lines.join("\n").trimEnd();
}
