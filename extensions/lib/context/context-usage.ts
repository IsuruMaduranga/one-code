/**
 * `/context`'s numbers: what fills the context window, estimated from the
 * session's last request as it went on the wire (the ledger's record,
 * lib/request/ledger/fold.ts `lastRequest`), with the total taken from what the
 * provider reported for it. Claude Code 2.1.330's `/context` is the model
 * (working-docs/features/ui-parity/evidence/screens/cc-05-context*.txt): a grid
 * of cells, "Estimated usage by category", the auto-compact window and the
 * per-item lists.
 *
 * Think in the array: the request is a system prompt, declared tools and one
 * list. Each piece is sized with pi-ai's characters-per-token estimate
 * (lib/models/pi-ai-estimate.ts), never a model call:
 *   - the system prompt (the head's `system`, `instructions` or
 *     `systemInstruction`, and the list's system or developer messages);
 *   - the declared tools, split by name into built-in and MCP (`mcp__*`); a
 *     declaration the provider loads on demand (`defer_loading`) is listed,
 *     not counted, until a `tool_reference` loads it;
 *   - the harness blocks, recognized by the words that open them, wherever
 *     they ride (a block of their own, or one of several merged into a
 *     system message, `harnessSegments`): the deferred-tool listing (its
 *     lines go to built-in or MCP tools), the agent listing (a custom
 *     agent's row is Custom agents, the rest built-in tools: `agentGroups`),
 *     the MCP servers' instructions, the skills listing, and instruction
 *     files (split per `Contents of <path> (<source>):` section); any other
 *     system-reminder of the first user message, and any other text of a
 *     system message, is session context and counts as system prompt;
 *   - everything else is messages.
 * The rows are scaled to the provider's prompt count for that request when
 * the two are within a factor of two of each other, so they add up to the
 * total shown; otherwise they stay estimates and a note says so. The reply
 * and anything sent since (pi's context estimate, the footer's number, minus
 * that prompt) is messages.
 *
 * Pure: no pi extension API.
 */

import { isAbsolute } from "node:path";
import { isPlainObject } from "../core/plain-object.ts";
import { ESTIMATED_IMAGE_CHARS, estimateCharTokens, estimateTextTokens } from "../models/pi-ai-estimate.ts";
import { declarationsOf, toolName } from "../request/ledger/wire.ts";
import { toolSearchResultText } from "../request/tool-search-text.ts";
import { instructionType } from "./context-text.ts";

/** The categories in Claude Code's order. */
export const CONTEXT_CATEGORIES = [
	["systemPrompt", "System prompt"],
	["systemTools", "System tools"],
	["mcpTools", "MCP tools"],
	["mcpInstructions", "MCP server instructions"],
	["agents", "Custom agents"],
	["memory", "Memory files"],
	["skills", "Skills"],
	["messages", "Messages"],
] as const;

export type ContextCategoryKey = (typeof CONTEXT_CATEGORIES)[number][0];

/**
 * The words that open each harness block. The base words them elsewhere (the
 * skill and MCP features, which lib may not load, and factories that need a
 * profile); context-usage.test.ts
 * checks these against the source text, so a reworded header fails there.
 */
export const BLOCK_HEADS = {
	skills: "The following skills are available for use with the Skill tool:",
	/** The skills listing of a session without the skill tool, framed for reading each skill's file. */
	readableSkills: "The following skills provide specialized instructions for specific tasks.",
	mcpInstructions: "# MCP Server Instructions",
	agents: "Available agent types for the Agent tool:",
	instructions: "Codebase and user instructions are shown below.",
} as const;

/** The deferred-tool listing's opening lines: the first message's, and a later addition's. */
const DEFERRED_HEADS = [toolSearchResultText.listingHead, toolSearchResultText.addendumHead];

/** An instruction file's section line: `Contents of <path> (<source>):`. */
const SECTION_LINE = /^Contents of (.+) \(([^()]+)\):$/;

const REMINDER_OPEN = "<system-reminder>";

/** Keys whose strings are ids, markers or opaque blobs, not text the model reads. */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
	"signature",
	// pi's own message list keeps a thinking block's and a text block's signatures here.
	"thinkingSignature",
	"textSignature",
	"encrypted_content",
	"thoughtSignature",
	"thought_signature",
	"data",
	"id",
	"call_id",
	"tool_use_id",
	"tool_call_id",
	"type",
	"role",
	"cache_control",
	"cachePoint",
	"status",
]);

/** Keys holding a structured argument or schema, sized as JSON. */
const JSON_KEYS: ReadonlySet<string> = new Set(["input", "arguments", "args", "parameters", "input_schema", "inputSchema"]);

const IMAGE_TYPES: ReadonlySet<string> = new Set(["image", "input_image", "image_url"]);

/** The characters of `value` the model reads, by pi-ai's measure where it has one. */
function charsOf(value: unknown, key?: string): number {
	if (typeof value === "string") return key !== undefined && OPAQUE_KEYS.has(key) ? 0 : value.length;
	if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + charsOf(item), 0);
	if (!isPlainObject(value)) return 0;
	if (key !== undefined && JSON_KEYS.has(key)) return JSON.stringify(value)?.length ?? 0;
	if ((typeof value.type === "string" && IMAGE_TYPES.has(value.type)) || "inlineData" in value || "image" in value) return ESTIMATED_IMAGE_CHARS;
	let chars = 0;
	for (const [field, inner] of Object.entries(value)) chars += charsOf(inner, field);
	return chars;
}

const tokensOf = (chars: number): number => (chars > 0 ? estimateCharTokens(chars) : 0);
const textTokens = (text: string): number => (text ? estimateTextTokens(text) : 0);

/** A list element's text blocks, its role, and the characters of everything else in it. */
function elementParts(element: unknown): { role?: string; texts: string[]; otherChars: number } {
	if (!isPlainObject(element)) return { texts: [], otherChars: charsOf(element) };
	const role = typeof element.role === "string" ? element.role : undefined;
	const content = element.content ?? element.parts;
	const texts: string[] = [];
	if (typeof content === "string") texts.push(content);
	else if (Array.isArray(content)) {
		for (const part of content) {
			if (isPlainObject(part) && typeof part.text === "string" && (part.type === undefined || part.type === "text" || part.type === "input_text" || part.type === "output_text")) {
				texts.push(part.text);
			}
		}
	}
	const textChars = texts.reduce((sum, text) => sum + text.length, 0);
	return { role, texts, otherChars: Math.max(0, charsOf(element) - textChars) };
}

/** A block's text without its system-reminder frame, and whether it had one. */
function unwrap(text: string): { body: string; framed: boolean } {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(REMINDER_OPEN)) return { body: trimmed, framed: false };
	return { body: trimmed.slice(REMINDER_OPEN.length).replace(/<\/system-reminder>\s*$/, "").trim(), framed: true };
}

/** One tool's or file's share, by name. */
export interface ContextItem {
	name: string;
	tokens: number;
	/** Where it comes from, Claude Code's label: a custom agent's group (Project, User, Plugin (<name>)), an instruction file's type (Project, User, Local, Managed, AutoMem). */
	group?: string;
}

/** The estimate of one request, before it is reconciled with the provider's count. */
export interface RequestBreakdown {
	tokens: Record<ContextCategoryKey, number>;
	memoryFiles: ContextItem[];
	skills: ContextItem[];
	/** Custom agents' rows of the agent listing, each with its group. */
	agents: ContextItem[];
	/** Loaded MCP tools (declared up front, or loaded by reference). */
	mcpLoaded: ContextItem[];
	/** MCP tools the model can load but has not. */
	mcpAvailable: string[];
}

/** The session's last request as the ledger recorded it: the body's list and every other field. */
export interface RecordedRequestView {
	api: string;
	head: Record<string, unknown>;
	list: readonly unknown[];
}

const isMcp = (name: string): boolean => name.startsWith("mcp__");

/** A Responses list item that declares tools itself: `additional_tools` or `tool_search_output`. */
function isDeclarationItem(item: unknown): item is Record<string, unknown> {
	return isPlainObject(item) && (item.type === "additional_tools" || item.type === "tool_search_output");
}

/** Tools a list declares itself, through its declaration items. */
function listDeclarations(list: readonly unknown[]): unknown[] {
	return list.flatMap((item) => (isDeclarationItem(item) && Array.isArray(item.tools) ? item.tools : []));
}

/** Every tool a `tool_reference` block in the list loads (Anthropic's deferred loading). */
function referencedTools(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) for (const item of value) referencedTools(item, into);
	else if (isPlainObject(value)) {
		if (value.type === "tool_reference" && typeof value.tool_name === "string") into.add(value.tool_name);
		else for (const inner of Object.values(value)) if (typeof inner === "object" && inner !== null) referencedTools(inner, into);
	}
	return into;
}

/** The name a deferred-listing line gives (`name` or `name: hint`), or undefined for prose. */
function listedName(line: string): string | undefined {
	const name = line.split(": ", 1)[0].trim();
	return /^[\w.:-]+$/.test(name) && !name.endsWith(":") ? name : undefined;
}

type BlockKind = "deferred" | "agents" | "mcpInstructions" | "skills" | "memory";

/** The words that open each kind of block. */
const HEADS: ReadonlyArray<readonly [string, BlockKind]> = [
	...DEFERRED_HEADS.map((head) => [head, "deferred"] as const),
	[BLOCK_HEADS.agents, "agents"],
	[BLOCK_HEADS.mcpInstructions, "mcpInstructions"],
	[BLOCK_HEADS.skills, "skills"],
	[BLOCK_HEADS.readableSkills, "skills"],
	[BLOCK_HEADS.instructions, "memory"],
];

/**
 * Where a merged block ends inside `text`: the first blank line before the
 * turn budget's `<total_tokens>` tag (any other tag, an agent description's
 * `<example>`, stays in the block), or before a line that is not a list row
 * (`list`); -1 for none.
 */
function blockEnd(text: string, list: boolean): number {
	const ends = [text.indexOf("\n\n<total_tokens>"), list ? text.search(/\n\n(?!- )/) : -1].filter((at) => at > 0);
	return ends.length > 0 ? Math.min(...ends) : -1;
}

/**
 * A text cut into the harness blocks it holds. A block starts at a line that
 * opens with a known head; a request whose model takes a mid-conversation
 * system message carries several blocks in one text, a blank line apart
 * (lib/request/system-role.ts), so a block other than instruction files also
 * ends where a blank line is followed by a tag (`<total_tokens>`), and the
 * skills listing, whose lines all start with `- `, where a blank line is
 * followed by anything else (the auto-mode note after it). The text
 * before the first block, and after such an end, has no kind. A text with no
 * head but an instruction file's section line is all instruction files (a
 * product's own block). Empty when the text holds no block at all.
 */
export function harnessSegments(body: string): Array<{ kind?: BlockKind; text: string }> {
	const marks: Array<{ at: number; kind?: BlockKind }> = [];
	for (const [head, kind] of HEADS) {
		for (let at = body.indexOf(head); at !== -1; at = body.indexOf(head, at + head.length)) {
			if (at === 0 || body[at - 1] === "\n") marks.push({ at, kind });
		}
	}
	if (marks.length === 0) return body.split("\n").some((line) => SECTION_LINE.test(line)) ? [{ kind: "memory", text: body }] : [];
	marks.sort((a, b) => a.at - b.at);
	const out: Array<{ kind?: BlockKind; text: string }> = [];
	const push = (kind: BlockKind | undefined, text: string) => {
		if (text.trim()) out.push({ ...(kind ? { kind } : {}), text });
	};
	push(undefined, body.slice(0, marks[0].at));
	marks.forEach((mark, index) => {
		const end = marks[index + 1]?.at ?? body.length;
		const text = body.slice(mark.at, end);
		const tag = mark.kind === "memory" ? -1 : blockEnd(text, mark.kind === "skills");
		if (tag === -1) push(mark.kind, text);
		else {
			push(mark.kind, text.slice(0, tag));
			push(undefined, text.slice(tag));
		}
	});
	return out;
}

/**
 * Estimate what `request` holds, by category. `displayPath` shows an
 * instruction file's path the way the user names it; `agentGroups` names each
 * custom agent's group (an agent it does not name is built in).
 */
export interface BreakdownOptions {
	displayPath?: (path: string) => string;
	/** The agent listing's row names, each with a custom agent's group (undefined for a built-in row). */
	agentGroups?: ReadonlyMap<string, string | undefined>;
}

export function breakdownRequest(request: RecordedRequestView, options: BreakdownOptions = {}): RequestBreakdown {
	const tokens = Object.fromEntries(CONTEXT_CATEGORIES.map(([key]) => [key, 0])) as Record<ContextCategoryKey, number>;
	const memory = new Map<string, number>();
	const memoryTypes = new Map<string, string>();
	const skills: ContextItem[] = [];
	const agents: ContextItem[] = [];
	const agentGroups = options.agentGroups ?? new Map<string, string | undefined>();
	const mcpLoaded = new Map<string, number>();
	const mcpAvailable = new Set<string>();
	const show = options.displayPath ?? ((path: string) => path);

	// The system prompt where the API keeps it outside the list.
	const config = isPlainObject(request.head.config) ? request.head.config : undefined;
	tokens.systemPrompt += tokensOf(charsOf(request.head.system) + charsOf(request.head.instructions) + charsOf(config?.systemInstruction));

	// Declared tools: counted when loaded, listed when only loadable.
	const list = request.list;
	const referenced = referencedTools(list);
	for (const tool of [...declarationsOf(request.head), ...listDeclarations(list)]) {
		const name = toolName(tool);
		if (name === undefined) continue;
		const deferred = isPlainObject(tool) && tool.defer_loading === true && !referenced.has(name);
		if (deferred) {
			if (isMcp(name)) mcpAvailable.add(name);
			continue;
		}
		const size = textTokens(JSON.stringify(tool) ?? "");
		if (isMcp(name)) {
			tokens.mcpTools += size;
			mcpLoaded.set(name, (mcpLoaded.get(name) ?? 0) + size);
		} else tokens.systemTools += size;
	}

	/** Size one harness block of a known kind. */
	const sizeBlock = (kind: BlockKind, body: string): void => {
		if (kind === "deferred") {
			let rest = textTokens(body);
			for (const line of body.split("\n").slice(1)) {
				const name = listedName(line);
				if (name === undefined || !isMcp(name)) continue;
				const share = textTokens(line);
				tokens.mcpTools += share;
				rest -= share;
				mcpAvailable.add(name);
			}
			tokens.systemTools += Math.max(0, rest);
		} else if (kind === "agents") {
			// A row runs from its `- name: ` line, a name the catalog has, to the next row: a description may hold blank lines and `- x: ` bullets. The note after the list follows the last blank line.
			const listEnd = body.lastIndexOf("\n\n");
			let current: ContextItem | undefined;
			let custom = 0;
			for (const line of (listEnd > 0 ? body.slice(0, listEnd) : body).split("\n")) {
				const row = /^- (\S+?): /.exec(line);
				if (row && agentGroups.has(row[1])) {
					const name = row[1];
					const group = agentGroups.get(name);
					// A listing sent again (the agent files changed) adds to the agent's row, not a second one.
					current = group ? agents.find((item) => item.name === name) : undefined;
					if (group && !current) agents.push((current = { name, tokens: 0, group }));
				}
				if (current) {
					const share = textTokens(line);
					current.tokens += share;
					custom += share;
				}
			}
			tokens.agents += custom;
			tokens.systemTools += Math.max(0, textTokens(body) - custom);
		} else if (kind === "mcpInstructions") tokens.mcpInstructions += textTokens(body);
		else if (kind === "skills") {
			tokens.skills += textTokens(body);
			for (const line of body.split("\n")) {
				const match = /^- (\S+?): /.exec(line);
				if (match) skills.push({ name: match[1], tokens: textTokens(line) });
			}
		} else {
			tokens.memory += textTokens(body);
			let current: string | undefined;
			let section: string[] = [];
			const close = () => {
				if (current !== undefined) memory.set(current, (memory.get(current) ?? 0) + textTokens(section.join("\n")));
			};
			for (const line of body.split("\n")) {
				const match = SECTION_LINE.exec(line);
				if (match) {
					close();
					current = show(match[1]);
					// A file the base does not word (a product's own) is the user's when it sits outside the project.
					memoryTypes.set(current, instructionType(match[2]) ?? (current.startsWith("~") || isAbsolute(current) ? "User" : "Project"));
					section = [line];
				} else section.push(line);
			}
			close();
		}
	};

	// pi's own message list (an estimate of a request not yet sent) also opens with a harness message or a compaction summary.
	const firstUser = list.findIndex((element) => isPlainObject(element) && (element.role === "user" || element.role === "custom" || element.role === "compactionSummary"));
	list.forEach((element, index) => {
		if (isDeclarationItem(element)) return;
		const { role, texts, otherChars } = elementParts(element);
		const instruction = role === "system" || role === "developer";
		for (const text of texts) {
			const { body, framed } = unwrap(text);
			// Harness text the words do not name is session context in the first user message or a system message, else conversation.
			const other: ContextCategoryKey = instruction || (framed && index === firstUser) ? "systemPrompt" : "messages";
			// Harness blocks sit only in a system or developer message or inside a system-reminder frame;
			// anything else (a reply, a tool result, the user's words) is conversation, whatever its lines look like.
			const segments = instruction || framed ? harnessSegments(body) : [];
			if (segments.length === 0) tokens[other] += textTokens(text);
			for (const segment of segments) {
				if (segment.kind) sizeBlock(segment.kind, segment.text);
				else tokens[other] += textTokens(segment.text);
			}
		}
		tokens.messages += tokensOf(otherChars);
	});

	const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
	return {
		tokens,
		memoryFiles: [...memory].map(([name, size]) => ({ name, tokens: size, group: memoryTypes.get(name) })),
		skills: skills.sort((a, b) => b.tokens - a.tokens),
		agents: agents.sort((a, b) => b.tokens - a.tokens),
		mcpLoaded: [...mcpLoaded].map(([name, size]) => ({ name, tokens: size })).sort((a, b) => byName(a.name, b.name)),
		mcpAvailable: [...mcpAvailable].filter((name) => !mcpLoaded.has(name)).sort(byName),
	};
}

/** A tool as pi holds its definition (`getAllTools`). */
export interface ToolDefinitionLike {
	name: string;
	description?: string;
	parameters?: unknown;
}

/**
 * The request the next prompt will send, as far as it is known before it
 * goes: the system prompt the system-prompt extension builds for it, the
 * tools it declares up front (and the deferred ones it lists, which cost
 * nothing until loaded), and `list`, the conversation with the
 * first-message stack placed by the real renderer (lib/request/reminders.ts
 * `renderReminders`). Declarations are sized in pi's shape, which differs from
 * a provider's wire shape by a few field names.
 */
export function previewRequest(parts: { systemPrompt: string; tools: readonly ToolDefinitionLike[]; deferred: readonly string[]; list: readonly unknown[] }): RecordedRequestView {
	return {
		api: "preview",
		head: {
			system: parts.systemPrompt,
			tools: [
				...parts.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: tool.parameters ?? {} })),
				...parts.deferred.map((name) => ({ name, defer_loading: true })),
			],
		},
		list: parts.list,
	};
}

/** What the branch says about the last reply: its prompt count, and whether a compaction came after it. */
export interface BranchUsage {
	/** The provider's prompt tokens for the request the last reply answered (input, cache reads and cache writes). */
	prompt?: number;
	/** A compaction is newer than the last reply: the recorded request no longer describes the context. */
	compacted: boolean;
}

interface BranchEntryLike {
	type: string;
	message?: { role?: string; stopReason?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; totalTokens?: number } };
}

/** The last reply pi would count (as its `getContextUsage` does: not aborted, not an error, usage above zero) and any compaction after it. */
export function branchUsage(branch: readonly BranchEntryLike[]): BranchUsage {
	let reply = -1;
	let prompt: number | undefined;
	let compaction = -1;
	branch.forEach((entry, index) => {
		if (entry.type === "compaction") compaction = index;
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return;
		const usage = message.usage;
		const input = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		if (input + (usage?.output ?? 0) <= 0 && !(usage?.totalTokens && usage.totalTokens > 0)) return;
		reply = index;
		prompt = input;
	});
	return { ...(prompt !== undefined ? { prompt } : {}), compacted: compaction > reply };
}

export interface ContextCategory {
	key: ContextCategoryKey;
	name: string;
	tokens: number;
}

/** Everything `/context` shows; plain data, so a transcript entry can store it and render it at any width. */
export interface ContextUsage {
	model: { name: string; id: string };
	window: number;
	/** "measured" from a recorded request; "empty" before any is recorded; "compacted" when a compaction came after the last one. */
	state: "measured" | "empty" | "compacted";
	/** Tokens in context: the provider's count when known, else the estimate; undefined when nothing is measured. */
	total?: number;
	/** The rows with tokens, in Claude Code's order. */
	categories: ContextCategory[];
	/** The auto-compact buffer: the window minus the threshold pi compacts at; 0 when auto-compaction is off. */
	buffer: number;
	/** Undefined when nothing is measured. */
	free?: number;
	/** Set when the provider's count is too far from the estimate to scale the rows: the provider's prompt tokens. */
	unreconciled?: number;
	/** The rows estimate the request the next prompt will send: none sent yet ("first") or none since a compaction. */
	preview?: "first" | "compaction";
	/** Why estimating the next request failed, when it did: the screen then says so instead of "nothing sent". */
	estimateError?: string;
	memoryFiles: ContextItem[];
	skills: ContextItem[];
	agents: ContextItem[];
	mcp: { loaded: ContextItem[]; available: string[] };
}

export interface ContextUsageInput {
	model: { name: string; id: string };
	window: number;
	/** pi's compaction settings: auto-compaction on, and the tokens it keeps free (it compacts past window minus reserve). */
	compaction?: { enabled: boolean; reserveTokens: number };
	/** The recorded request's breakdown; undefined when none applies. */
	breakdown?: RequestBreakdown;
	/** The provider's prompt tokens for that request, and pi's context total (the footer's number). */
	reported?: { prompt: number; total: number };
	/** A compaction came after the last recorded request. */
	compacted?: boolean;
	/** `breakdown` is of the request the next prompt will send (`previewRequest`), not of one sent. */
	preview?: "first" | "compaction";
	/** Estimating the next request threw: its message. */
	estimateError?: string;
}

/** The band within which the provider's count rescales the estimate; outside it one of the two is off and the rows stay estimates. */
const PLAUSIBLE_RATIO = 2;

/** `values` scaled to sum exactly `target`, by largest remainder. */
export function scaleToSum(values: readonly number[], target: number): number[] {
	const sum = values.reduce((a, b) => a + b, 0);
	if (sum <= 0) return values.map(() => 0);
	const exact = values.map((value) => (value * target) / sum);
	const floors = exact.map(Math.floor);
	let left = target - floors.reduce((a, b) => a + b, 0);
	const order = exact.map((value, index) => ({ index, remainder: value - floors[index] })).sort((a, b) => b.remainder - a.remainder);
	for (const { index } of order) {
		if (left <= 0) break;
		floors[index]++;
		left--;
	}
	return floors;
}

/** The numbers `/context` shows. */
export function contextUsage(input: ContextUsageInput): ContextUsage {
	const window = Math.max(0, input.window);
	const buffer = input.compaction?.enabled ? Math.min(window, Math.max(0, input.compaction.reserveTokens)) : 0;
	const base = { model: input.model, window, buffer };
	const empty = { memoryFiles: [], skills: [], agents: [], mcp: { loaded: [], available: [] } };
	const breakdown = input.breakdown;
	if (!breakdown) return { ...base, ...empty, state: input.compacted ? "compacted" : "empty", categories: [], ...(input.estimateError !== undefined ? { estimateError: input.estimateError } : {}) };

	const keys = CONTEXT_CATEGORIES.map(([key]) => key);
	let values = keys.map((key) => breakdown.tokens[key]);
	const estimate = values.reduce((a, b) => a + b, 0);
	let factor = 1;
	let unreconciled: number | undefined;
	const reported = input.reported;
	if (reported && reported.prompt > 0 && estimate > 0) {
		const ratio = reported.prompt / estimate;
		if (ratio >= 1 / PLAUSIBLE_RATIO && ratio <= PLAUSIBLE_RATIO) {
			factor = ratio;
			values = scaleToSum(values, reported.prompt);
		} else unreconciled = reported.prompt;
	}
	// The reply and whatever was sent since: pi's total past the request's prompt.
	if (reported) values[keys.indexOf("messages")] += Math.max(0, reported.total - reported.prompt);
	const rows = values.reduce((a, b) => a + b, 0);
	const total = reported && unreconciled === undefined ? Math.max(rows, reported.total) : reported ? reported.total : rows;
	const scale = (items: readonly ContextItem[]) => items.map((item) => ({ ...item, tokens: Math.round(item.tokens * factor) }));
	return {
		...base,
		state: "measured",
		total,
		categories: CONTEXT_CATEGORIES.map(([key, name], index) => ({ key, name, tokens: values[index] })).filter((row) => row.tokens > 0),
		// Unreconciled rows may exceed the total: free space never contradicts them either.
		free: Math.max(0, window - Math.max(total, rows) - buffer),
		...(unreconciled !== undefined ? { unreconciled } : {}),
		...(input.preview ? { preview: input.preview } : {}),
		memoryFiles: scale(breakdown.memoryFiles),
		skills: scale(breakdown.skills),
		agents: scale(breakdown.agents),
		mcp: { loaded: scale(breakdown.mcpLoaded), available: breakdown.mcpAvailable },
	};
}

/** What a grid cell shows. */
export interface ContextCell {
	kind: ContextCategoryKey | "free" | "buffer";
	/** How much of the cell the category fills (the last, partial cell of a category is below 1). */
	fullness: number;
}

/** Claude Code's grid size: 20 by 10 for a window of a million tokens or more, 10 by 10 below; 5 columns (and 5 rows below a million) on a terminal under 80 columns. */
export function gridSize(window: number, narrow: boolean): { columns: number; rows: number } {
	const large = window >= 1_000_000;
	return { columns: narrow ? 5 : large ? 20 : 10, rows: large || !narrow ? 10 : 5 };
}

/**
 * The grid, row by row, as Claude Code lays it out: each category takes its
 * share of the cells (at least one), in order, then free cells, and the
 * buffer's cells last.
 */
export function contextGrid(usage: ContextUsage, narrow: boolean): ContextCell[][] {
	const { columns, rows } = gridSize(usage.window, narrow);
	const total = columns * rows;
	const cells: ContextCell[] = [];
	const share = (tokens: number) => (usage.window > 0 ? (tokens / usage.window) * total : 0);
	const place = (kind: ContextCell["kind"], tokens: number) => {
		const exact = share(tokens);
		const count = Math.max(1, Math.round(exact));
		const whole = Math.floor(exact);
		const out: ContextCell[] = [];
		for (let i = 0; i < count; i++) out.push({ kind, fullness: i === whole && exact > whole ? exact - whole : 1 });
		return out;
	};
	for (const category of usage.categories) for (const cell of place(category.key, category.tokens)) if (cells.length < total) cells.push(cell);
	const buffer = usage.buffer > 0 ? place("buffer", usage.buffer) : [];
	while (cells.length < total - buffer.length) cells.push({ kind: "free", fullness: 1 });
	for (const cell of buffer) if (cells.length < total) cells.push(cell);
	const grid: ContextCell[][] = [];
	for (let row = 0; row < rows; row++) grid.push(cells.slice(row * columns, (row + 1) * columns));
	return grid;
}

/** Claude Code's token figure: `592`, `2.5k`, `950.3k`, `1m`. */
export function formatContextTokens(tokens: number): string {
	return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(tokens).toLowerCase();
}

/** A row's share of the window as Claude Code 2.1.330 prints it: one decimal under 1%, whole percent above. */
export function formatContextPercent(tokens: number, window: number): string {
	if (window <= 0) return "0";
	const percent = (tokens / window) * 100;
	const tenth = Math.round(percent * 10) / 10;
	return tenth < 1 ? tenth.toFixed(1) : String(Math.round(percent));
}
