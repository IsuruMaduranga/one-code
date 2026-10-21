/**
 * Keep the previous request's conversation breakpoint (pure).
 *
 * Anthropic finds an earlier cache entry only a limited way back from a
 * breakpoint, about 20 content blocks, and pi moves the one conversation
 * breakpoint to each request's tail. A request that adds many blocks since the
 * last one (a large parallel tool batch), or a long run of `tool_addition`
 * blocks after the session-facts system message, then cannot reach the entry
 * the previous request wrote and re-caches the whole conversation (findings
 * §72: a live pair read 11,707 of 24,837 tokens, and 24,837 with this mark).
 * Marking the block the previous request marked again lets the server match
 * that entry directly. It costs nothing: the entry exists, so the mark reads.
 */

import { appendPoint } from "./ledger/wire.ts";
import { MAX_CACHE_MARKERS } from "./request-replay.ts";

type Block = Record<string, unknown> & { cache_control?: unknown };
type Message = { role?: unknown; content?: unknown };

/** Where a request's last conversation breakpoint sat, and the block it marked. */
export interface MessageMark {
	message: number;
	block: number;
	marker: unknown;
	/** The marked block itself: pi builds each request afresh but reuses large strings (an image's data), so a structural compare short-circuits on them. */
	content: Block;
}

const blocksOf = (message: unknown): Block[] =>
	Array.isArray((message as Message | null)?.content) ? ((message as Message).content as Block[]) : [];

/** Equal JSON values, ignoring a top-level `cache_control`. */
function sameBlock(a: Block, b: Block): boolean {
	const keys = (block: Block) => Object.keys(block).filter((key) => key !== "cache_control");
	const left = keys(a);
	return left.length === keys(b).length && left.every((key) => sameValue(a[key], b[key]));
}
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
	const left = Object.keys(a);
	return left.length === Object.keys(b).length && left.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** The last breakpoint in `messages`, or undefined when none carries one. */
export function lastMessageMark(messages: unknown): MessageMark | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let message = messages.length - 1; message >= 0; message--) {
		const blocks = blocksOf(messages[message]);
		for (let block = blocks.length - 1; block >= 0; block--) {
			const marker = blocks[block]?.cache_control;
			if (marker !== undefined) return { message, block, marker, content: blocks[block] };
		}
	}
	return undefined;
}

function marksIn(value: unknown): number {
	if (!Array.isArray(value)) return 0;
	return value.reduce((sum: number, entry) => {
		const own = (entry as Block | null)?.cache_control !== undefined ? 1 : 0;
		return sum + own + blocksOf(entry).filter((block) => block?.cache_control !== undefined).length;
	}, 0);
}

/**
 * The payload with `previous` marked again: only when that block is still
 * there with the same bytes, no later block already took its place as the
 * tail mark, and a breakpoint slot is free. Otherwise the payload unchanged.
 */
export function withPreviousMark<T extends Record<string, unknown>>(payload: T, previous: MessageMark | undefined): T {
	if (!previous || !Array.isArray(payload.messages)) return payload;
	const messages = payload.messages as Message[];
	const blocks = blocksOf(messages[previous.message]);
	const target = blocks[previous.block];
	if (!target || target.cache_control !== undefined || !sameBlock(target, previous.content)) return payload;
	if (marksIn(payload.tools) + marksIn(payload.system) + marksIn(messages) >= MAX_CACHE_MARKERS) return payload;
	const copy = [...messages];
	const content = [...blocks];
	content[previous.block] = { ...target, cache_control: previous.marker };
	copy[previous.message] = { ...messages[previous.message], content };
	return { ...payload, messages: copy };
}

/**
 * The breakpoint the base request carried, located in `messages` (the request
 * that extends it, spliced): the last block of the base's last element before
 * its trailing directives, with the marker this request's own tail mark uses.
 * Undefined when the request has no tail mark or the base is empty.
 */
export function baseMark(messages: unknown, baseList: readonly unknown[], api: string): MessageMark | undefined {
	if (!Array.isArray(messages)) return undefined;
	const end = appendPoint(baseList, api);
	const tail = lastMessageMark(messages);
	if (end === 0 || !tail || tail.message < end) return undefined;
	const blocks = blocksOf(messages[end - 1]);
	const block = blocks.length - 1;
	if (block < 0) return undefined;
	return { message: end - 1, block, marker: tail.marker, content: blocks[block] };
}
