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

import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { toolResultsOnBranch } from "./branch-restore.ts";
import { parseClaudeVersion } from "./model-tier.ts";
import { normalizeToolName } from "../permissions/matcher.ts";

export const DEFER_CHANNEL = "one-code:defer-tool";

/**
 * Take a deferred tool out of this session's surface (`{ name }`): it leaves the
 * deferred registry and the active set, so no request carries it and
 * `tool_search` cannot load it. An extension withholds its own tool when the
 * session model must not have it (the task tools on frontier models) and
 * re-emits DEFER_CHANNEL to bring it back after a model change. Before the
 * first request the standing listing is rewritten without it; after that the
 * listing stays frozen and a load reports "not found" (tool-search/announce.ts).
 */
export const WITHHOLD_CHANNEL = "one-code:withhold-tool";

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

	remove(name: string): boolean {
		return this.entries.delete(name);
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

/** The `tool_search` calls that loaded tools: each call's id → the names it loaded. */
export type ToolSearchLoads = ReadonlyMap<string, readonly string[]>;

/**
 * Every load recorded on a session branch: a `tool_search` result whose
 * persisted `details.added` names the tools it activated. Read once at
 * session start (a resumed session's earlier loads); loads made during the
 * session are captured at the call itself.
 */
export function toolSearchLoads(branch: readonly SessionEntry[]): Map<string, string[]> {
	const loads = new Map<string, string[]>();
	for (const message of toolResultsOnBranch(branch, TOOL_SEARCH_NAMES)) {
		const added = (message.details as { added?: unknown } | undefined)?.added;
		if (!Array.isArray(added)) continue;
		const names = added.filter((n): n is string => typeof n === "string");
		if (names.length > 0) loads.set(message.toolCallId, names);
	}
	return loads;
}
const TOOL_SEARCH_NAMES: ReadonlySet<string> = new Set(["tool_search"]);

type WireTool = Record<string, unknown> & { name: string };
type WireBlock = Record<string, unknown> & { type?: unknown };
type WireMessage = { role?: unknown; content?: unknown };

/** A deferred definition in pi's own `convertTools` shape (findings §7). */
function deferredDefinition(tool: DeferrableToolInfo): WireTool {
	return {
		name: tool.name,
		description: tool.description ?? "",
		input_schema: {
			type: "object",
			properties: tool.parameters?.properties ?? {},
			required: tool.parameters?.required ?? [],
		},
		defer_loading: true,
	};
}

/** The list with pi's cache breakpoint on its last item (a no-op without one). */
function withBreakpointOnLast<T extends Record<string, unknown>>(items: T[], cache_control: unknown): T[] {
	if (cache_control === undefined || items.length === 0) return items;
	return [...items.slice(0, -1), { ...items[items.length - 1], cache_control }];
}

/**
 * An Anthropic request whose `tools` array is byte-identical to request 1's,
 * whatever `tool_search` has loaded since — the client side of Anthropic's
 * deferred-tool contract, which pi 0.86 no longer supplies for One Code
 * (rationale and measurements: working-docs/decisions/caching.md "Loaded deferred
 * tools stay deferred on the wire", findings §7).
 *
 * - Every registry tool `isDeferred` that is not eager on the wire is appended
 *   as a `defer_loading: true` definition, sorted by name; pi's own rendering
 *   of a later-deferred registry tool is replaced by ours.
 * - A loaded tool pi promoted to eager is demoted back to deferred, the tools
 *   cache breakpoint moves to the last remaining eager tool, and the
 *   `tool_search` result that loaded it (`loads`) is rewritten to
 *   `tool_reference` blocks, its own content moving to trailing sibling blocks
 *   that take the result's breakpoint (Anthropic rejects references mixed with
 *   ordinary result content). Demotion happens only when that result is on the
 *   wire and precedes every `tool_use` of the tool; otherwise the tool stays
 *   eager (one accepted cache miss, never a request Anthropic rejects).
 * - pi's own deferred entries that are not registry tools (its
 *   `__pi_deferred_placeholder__`) stay in place.
 *
 * Returns undefined (leave the payload alone) when the request carries no
 * tools or the wire names are not the registry's (pi's OAuth "stealth" mode
 * renames them to Claude Code casing, and an unmatched name must not be
 * duplicated). Never mutates its input.
 */
export function stabilizeDeferredTools(
	payload: Record<string, unknown>,
	tools: readonly DeferrableToolInfo[],
	isDeferred: (name: string) => boolean,
	loads: ToolSearchLoads = new Map(),
): Record<string, unknown> | undefined {
	const existing = payload.tools;
	if (!Array.isArray(existing) || existing.length === 0) return undefined;
	const registry = new Set(tools.map((t) => t.name));

	const eager: WireTool[] = [];
	const anchors: WireTool[] = [];
	for (const raw of existing) {
		const tool = raw as WireTool | null;
		if (typeof tool?.name !== "string") return undefined;
		if (!registry.has(tool.name)) {
			if (tool.defer_loading === true) anchors.push(tool);
			else return undefined;
			continue;
		}
		if (tool.defer_loading !== true) eager.push(tool);
	}

	const messages: WireMessage[] = Array.isArray(payload.messages) ? (payload.messages as WireMessage[]) : [];
	const referencesAt = new Map<string, string[]>();
	const demoted = new Set<string>();
	if (loads.size > 0 && eager.some((tool) => isDeferred(tool.name))) {
		// Message index of each tool's first use and of each tool result: a
		// reference is valid only ahead of every use of the tool.
		const firstUse = new Map<string, number>();
		const resultAt = new Map<string, number>();
		messages.forEach((message, index) => {
			if (!Array.isArray(message?.content)) return;
			for (const block of message.content as WireBlock[]) {
				if (block?.type === "tool_use" && typeof block.name === "string" && !firstUse.has(block.name)) {
					firstUse.set(block.name, index);
				} else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
					resultAt.set(block.tool_use_id, index);
				}
			}
		});
		const loaderOf = earliestLoads(loads, (callId) => resultAt.get(callId));
		for (const tool of eager) {
			if (!isDeferred(tool.name)) continue;
			const loader = loaderOf.get(tool.name);
			if (loader === undefined) continue;
			const use = firstUse.get(tool.name);
			if (use !== undefined && use < loader.at) continue;
			demoted.add(tool.name);
			referencesAt.set(loader.callId, [...(referencesAt.get(loader.callId) ?? []), tool.name]);
		}
	}

	// pi puts the tools breakpoint on the last eager tool; if that one is demoted
	// the breakpoint moves to the new last one, otherwise nothing moves.
	const last = eager.at(-1);
	const keptEager = withBreakpointOnLast(
		eager.filter((tool) => !demoted.has(tool.name)),
		last !== undefined && demoted.has(last.name) ? last.cache_control : undefined,
	);
	if (keptEager.length === 0) return undefined;
	const eagerNames = new Set(keptEager.map((tool) => tool.name));
	const deferred = tools
		.filter((t) => isDeferred(t.name) && !eagerNames.has(t.name))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map(deferredDefinition);
	return {
		...payload,
		tools: [...keptEager, ...anchors, ...deferred],
		messages: referencesAt.size === 0 ? payload.messages : messages.map((m) => withToolReferences(m, referencesAt)),
	};
}

/**
 * The user message with each loading `tool_result` rewritten to carry its
 * `tool_reference` blocks and its original content moved to trailing sibling
 * blocks; a breakpoint on the rewritten result moves to the new last block so
 * the whole message stays inside the cached prefix.
 */
function withToolReferences(message: WireMessage, referencesAt: ReadonlyMap<string, readonly string[]>): WireMessage {
	if (message?.role !== "user" || !Array.isArray(message.content)) return message;
	const content = message.content as WireBlock[];
	if (!content.some((block) => block?.type === "tool_result" && referencesAt.has(block.tool_use_id as string))) return message;

	const blocks: WireBlock[] = [];
	const siblings: WireBlock[] = [];
	let movedBreakpoint: unknown;
	for (const block of content) {
		const names = block?.type === "tool_result" ? referencesAt.get(block.tool_use_id as string) : undefined;
		if (!names) {
			blocks.push(block);
			continue;
		}
		const { content: original, cache_control, ...rest } = block;
		if (cache_control !== undefined) movedBreakpoint = cache_control;
		blocks.push({ ...rest, content: names.map((name) => ({ type: "tool_reference", tool_name: name })) });
		if (typeof original === "string") {
			if (original.trim().length > 0) siblings.push({ type: "text", text: original });
		} else if (Array.isArray(original)) {
			siblings.push(...(original as WireBlock[]));
		}
	}
	return { ...message, content: withBreakpointOnLast([...blocks, ...siblings], movedBreakpoint) };
}

/**
 * The earliest on-wire load of each tool: the `tool_search` call whose result
 * sits first in the conversation (`resultAt` is its index, undefined when it is
 * not on the wire).
 */
function earliestLoads(loads: ToolSearchLoads, resultAt: (callId: string) => number | undefined): Map<string, { callId: string; at: number }> {
	const loaderOf = new Map<string, { callId: string; at: number }>();
	for (const [callId, names] of loads) {
		const at = resultAt(callId);
		if (at === undefined) continue;
		for (const name of names) {
			const current = loaderOf.get(name);
			if (current === undefined || at < current.at) loaderOf.set(name, { callId, at });
		}
	}
	return loaderOf;
}

/** pi-ai's Responses APIs: requests carry `input` items and flat `{ type, name }` tools. */
const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

/** How a Responses model takes a mid-conversation tool load (pi-ai's model `compat` fields). */
export interface ToolLoadCompat {
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
}

/** The model fields that say whether, and how, a Responses request can add a tool mid-conversation. */
export interface ResponsesToolLoadModel {
	api?: string;
	compat?: ToolLoadCompat;
}

/**
 * The model's tool-load compat when it takes a mid-conversation tool load in
 * pi-ai's native Responses shape, else undefined.
 */
export function responsesToolLoadCompat(model: ResponsesToolLoadModel | undefined): ToolLoadCompat | undefined {
	if (!model?.api || !RESPONSES_APIS.has(model.api)) return undefined;
	const compat = model.compat;
	return compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true ? compat : undefined;
}

type WireItem = Record<string, unknown>;

/**
 * A Responses request whose `tools` array stays request 1's whatever
 * `tool_search` has loaded since: the OpenAI side of
 * {@link stabilizeDeferredTools}. pi 0.86 and later put a loaded tool into
 * `tools` for One Code (its forced system prompt collapses tool changes into
 * the head, findings §7), so every load re-cached the whole conversation (0
 * cached tokens on the request after a load on `openai-codex`, findings §45).
 *
 * A loaded registry tool leaves `tools` and enters the input right before the
 * `function_call_output` of the `tool_search` call that loaded it, in pi-ai's
 * own native shape (`convertResponsesMessages` `appendSystemToolAdditions`):
 * an `additional_tools` developer item when the model supports one, else a
 * `tool_search_call` + `tool_search_output` pair whose tools carry
 * `defer_loading: true`. A tool the model called before that output, or whose
 * loading output is not on the wire, stays in `tools`.
 *
 * Returns undefined (leave the payload alone) when nothing moves. Never
 * mutates its input.
 */
export function stabilizeResponsesToolLoads(
	payload: Record<string, unknown>,
	isDeferred: (name: string) => boolean,
	loads: ToolSearchLoads,
	compat: ToolLoadCompat,
): Record<string, unknown> | undefined {
	const tools = payload.tools;
	const input = payload.input;
	if (!Array.isArray(tools) || !Array.isArray(input) || loads.size === 0) return undefined;

	// Input index of each tool output and of each tool's first call. pi sends a
	// call id as `<call_id>|<item_id>`; the wire's `call_id` is the first part.
	const outputAt = new Map<string, number>();
	const firstUse = new Map<string, number>();
	(input as WireItem[]).forEach((item, index) => {
		if (item?.type === "function_call_output" && typeof item.call_id === "string") outputAt.set(item.call_id, index);
		else if ((item?.type === "function_call" || item?.type === "custom_tool_call") && typeof item.name === "string" && !firstUse.has(item.name)) {
			firstUse.set(item.name, index);
		}
	});
	const loaderOf = earliestLoads(loads, (callId) => outputAt.get(callId.split("|")[0]));

	const movedAt = new Map<number, WireItem[]>();
	const kept: unknown[] = [];
	for (const raw of tools) {
		const tool = raw as WireItem | null;
		const name = typeof tool?.name === "string" ? tool.name : undefined;
		const at = name !== undefined && isDeferred(name) ? loaderOf.get(name)?.at : undefined;
		const use = name !== undefined ? firstUse.get(name) : undefined;
		if (at === undefined || (use !== undefined && use < at)) {
			kept.push(raw);
			continue;
		}
		movedAt.set(at, [...(movedAt.get(at) ?? []), tool as WireItem]);
	}
	if (movedAt.size === 0) return undefined;

	const nextInput: unknown[] = [];
	(input as WireItem[]).forEach((item, index) => {
		const moved = movedAt.get(index);
		if (moved) nextInput.push(...toolLoadItems(moved, String(item.call_id), compat));
		nextInput.push(item);
	});
	return { ...payload, tools: kept, input: nextInput };
}

/** pi-ai's native items for tools added at one point of a Responses conversation. */
function toolLoadItems(tools: WireItem[], loaderCallId: string, compat: ToolLoadCompat): WireItem[] {
	if (compat.supportsAdditionalTools) return [{ type: "additional_tools", role: "developer", tools }];
	const names = tools.map((tool) => String(tool.name));
	const callId = `pi_tool_load_${createHash("sha256").update(`${loaderCallId}:${names.join(",")}`).digest("hex").slice(0, 16)}`;
	return [
		{ type: "tool_search_call", call_id: callId, execution: "client", status: "completed", arguments: { query: names.join(" "), limit: names.length } },
		{ type: "tool_search_output", call_id: callId, execution: "client", status: "completed", tools: tools.map((tool) => ({ ...tool, defer_loading: true })) },
	];
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

/**
 * The correction for a tool WITHHOLD_CHANNEL took away (the task tools on a
 * frontier or Sonnet 5+ model): unlike an ordinary deferred miss, `tool_search`
 * cannot load it — the name is gone from the registry, not merely inactive —
 * so the steer must NOT repeat `deferredMissReminderText`'s "load it with
 * tool_search" advice, which would just fail again.
 */
export function withheldMissReminderText(name: string): string {
	return `\`${name}\` failed with "Tool ${name} not found" because it was withdrawn for the current model — it is not a deferred tool you can load with tool_search. Do not retry it; continue without it.`;
}

export interface SearchMatch {
	name: string;
	score: number;
}

/**
 * The exact names a `select:` query asks for (lowercased and mapped through the
 * Claude Code alias table), or undefined when the query is not a select: query.
 * A CC-trained model writes `select:WebFetch,NotebookEdit`; without the alias
 * pass those are "not found — check spelling" even though the tools exist under
 * our names (TOOL-FIDELITY-REVIEW-2026-09-07 M1). Lets tool_search report which
 * requested names matched nothing instead of silently dropping them.
 */
export function selectedNames(query: string): string[] | undefined {
	const trimmed = query.trim();
	if (!trimmed.toLowerCase().startsWith("select:")) return undefined;
	return trimmed
		.slice("select:".length)
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean)
		// normalizeToolName lowercases ordinary names but PRESERVES case for
		// `mcp__…` names; the trailing toLowerCase keeps select: case-insensitive
		// for those too. Don't drop it as "redundant".
		.map((n) => normalizeToolName(n).toLowerCase());
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
