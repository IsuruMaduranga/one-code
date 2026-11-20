/**
 * A product's own block in the first-message context stack: project facts
 * a product extension wants the model to start every epoch with (the
 * project's layout, the services it runs), published through
 * `publishContextBlock` (extensions/sdk/extension.ts).
 *
 * The block is live state, as the base's own blocks are (decisions/caching.md,
 * "Message 1 is frozen"): it is rendered into message 1 when an epoch opens
 * (the first request, after a compaction or a model switch), and inside an
 * epoch a changed text rides the request's tail, live minus what the epoch
 * told, never a rewrite of message 1. At most one delta per key per request:
 * the text as it stands when the request renders, so a product that
 * republishes often still adds one block, and one that republishes the same
 * text adds nothing. A null, empty or whitespace-only text withdraws it.
 *
 * Each block sits at the stack's product slot (`CONTEXT_ORDER.productContext`:
 * after the context block, before the date, on the user message), under a
 * namespaced key, so it can never replace a base block. A text past
 * `CONTEXT_BLOCK_MAX_BYTES` is persisted to the session's folder and the
 * block carries the pointer (`persistIfLarge`), under a name that changes
 * only with the text, so the same text gives the same pointer, resumed or
 * not.
 *
 * The base's own block owners keep their own render handlers and may adopt
 * this helper in a separate change.
 *
 * A session's extensions share one event bus, and a child session has its
 * own: a block reaches a child only when the child loads an extension that
 * publishes it (the profile's `childExtensions`), as a base block reaches a
 * child only from the extensions a child loads.
 */

import { createHash } from "node:crypto";
import { brand, brandedId } from "../profile/brand.mjs";
import { persistIfLarge, sessionResultsDir } from "./persisted-output.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest, type ReminderPayload, toldBlockFact, untoldBlockFact } from "./reminders.ts";
import { contextBlockText } from "./context-block-text.ts";

/** The prefix every product block's key carries in the stack. */
export const PRODUCT_BLOCK_PREFIX = "product:";

/**
 * The keys of the base's own first-prepend blocks: a product key that
 * spells one is refused, so a product block is never mistaken for a base
 * one in a capture or a record. Held to the base's sources by
 * context-block.test.ts.
 */
export const BASE_BLOCK_KEYS: ReadonlySet<string> = new Set([
	"sandbox",
	"environment",
	"model-line",
	"one-shot",
	"deferred-tools",
	"subagent-models",
	"subagent-agents",
	"subagent-delegation",
	"mcp-failures",
	"mcp-instructions",
	"skills",
	"auto-mode-note",
	"total-tokens-first",
	"instructions",
	"instructions-context",
	"instructions-date",
	`${brand.idPrefix}-context`,
]);

/** The largest text a block carries whole, in UTF-8 bytes: the size of the largest bounded neighbour in the stack (the memory index). */
export const CONTEXT_BLOCK_MAX_BYTES = 25_000;

const KEY = /^[a-z0-9][a-z0-9-]*$/;

/** Answered by the extension that publishes a key on this bus, so a second one is refused (each extension has its own copy of this module). */
export const CONTEXT_BLOCK_OWNER_CHANNEL = brandedId("context-block-owner");

export interface OwnerProbe {
	key: string;
	owned?: boolean;
}

/** What a session needs for the file a large text is persisted to: its folder, the same on every resume. */
export interface ContextBlockSession {
	cwd: string;
	sessionManager: { getSessionDir: () => string | undefined; getSessionId: () => string };
}

interface Bus {
	on(channel: string, handler: (data: unknown) => void): unknown;
	emit(channel: string, data: unknown): void;
}

/** Per event bus (one per session), the blocks this extension publishes there. */
const published = new WeakMap<Bus, Map<string, { text: string | null }>>();

/** Why `key` cannot name a product block, or undefined. */
export function contextBlockKeyProblem(key: string): string | undefined {
	if (!KEY.test(key)) return `a context block's key must be lowercase letters, digits and hyphens, starting with a letter or digit: ${JSON.stringify(key)}`;
	if (BASE_BLOCK_KEYS.has(key)) return `"${key}" is the key of one of the base's own context blocks: name the product's block something else`;
	return undefined;
}

/**
 * Publish the product block `key` with `text`, or withdraw it with null (or
 * an empty or whitespace-only text, which says nothing).
 * Throws on a key that is malformed or names a base block, and on a key
 * another extension already publishes in this session.
 */
export function publishContextBlock(pi: { events: Bus }, session: ContextBlockSession, key: string, text: string | null): void {
	const problem = contextBlockKeyProblem(key);
	if (problem) throw new Error(problem);
	const live = text === null || text.trim() === "" ? null : text;
	const stackKey = `${PRODUCT_BLOCK_PREFIX}${key}`;
	let blocks = published.get(pi.events);
	if (!blocks) {
		const mine = new Map<string, { text: string | null }>();
		blocks = mine;
		published.set(pi.events, mine);
		pi.events.on(CONTEXT_BLOCK_OWNER_CHANNEL, (data) => {
			const probe = data as OwnerProbe;
			if (mine.has(probe.key)) probe.owned = true;
		});
	}
	let block = blocks.get(stackKey);
	if (!block) {
		const probe: OwnerProbe = { key: stackKey };
		pi.events.emit(CONTEXT_BLOCK_OWNER_CHANNEL, probe);
		if (probe.owned) throw new Error(`the context block "${key}" is already published by another extension in this session`);
		const state = { text: null as string | null };
		block = state;
		blocks.set(stackKey, state);
		// Inside an epoch, the live text minus what the epoch told: one block per request at most, the text as it is now.
		pi.events.on(RENDER_CHANNEL, (data) => {
			const request = data as RenderRequest;
			if (request.epoch) return;
			const fact = untoldBlockFact(request, stackKey, state.text);
			if (fact) request.blocks.push({ text: state.text ?? contextBlockText.withdrawn(key), facts: [fact] });
		});
	}
	const bounded = live === null ? null : boundedText(session, key, live);
	block.text = bounded;
	if (bounded === null) {
		pi.events.emit(REMINDER_CHANNEL, { key: stackKey, remove: true } satisfies ReminderPayload);
		return;
	}
	pi.events.emit(REMINDER_CHANNEL, {
		text: bounded,
		key: stackKey,
		placement: "first-prepend",
		order: CONTEXT_ORDER.productContext,
		facts: [toldBlockFact(stackKey, bounded)],
	} satisfies ReminderPayload);
}

/** The text whole while it fits, else the pointer to it persisted under a name that changes with its content. */
function boundedText(session: ContextBlockSession, key: string, text: string): string {
	// The session's folder is found (and made) only for a text that needs it.
	if (Buffer.byteLength(text, "utf-8") <= CONTEXT_BLOCK_MAX_BYTES) return text;
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
	return persistIfLarge(text, { dir: sessionResultsDir(session), id: `context-${key}-${digest}`, maxBytes: CONTEXT_BLOCK_MAX_BYTES });
}
