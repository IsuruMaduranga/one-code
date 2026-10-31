/**
 * Which delivered message takes a UserPromptSubmit hook's context. Pure (no pi
 * imports).
 *
 * A message queued mid-turn delivers as typed, so the user message with its
 * text is its own (lib/queued-delivery.ts). A prompt typed while idle is
 * expanded by pi after the input handlers (a prompt template, a `/skill:` no
 * extension took), and a later handler may transform it, so its message
 * rarely carries the typed text. It is the next prompt pi delivers, though:
 * the first user message no queued message claims takes it.
 *
 * A queued message is held even when its hook added no context, so its
 * delivery claims nothing instead of taking an idle prompt's context.
 */

import { QueuedDelivery } from "../lib/queued-delivery.ts";

export class PromptContextRouter {
	/** Context per queued message; null marks one whose hook added none. */
	private readonly queued = new QueuedDelivery<string | null>();
	private idle: Array<{ text: string; payload: string }> = [];

	/** A message queued mid-turn, with its hook's context or none. */
	holdQueued(text: string, payload: string | undefined): void {
		this.queued.hold(text, payload ?? null);
	}

	/** A prompt typed while idle and its hook's context. */
	holdIdle(text: string, payload: string): void {
		this.idle.push({ text, payload });
	}

	/** A new idle prompt: an earlier idle one was delivered or never will be, so its context is stale. */
	dropIdle(): void {
		this.idle = [];
	}

	get isEmpty(): boolean {
		return this.queued.isEmpty && this.idle.length === 0;
	}

	/**
	 * The context for a delivered user message with this text: a queued message
	 * typed so claims its own (none, when its hook added none); else the idle
	 * prompt typed so; else, unless `exact`, the oldest idle prompt. Released once.
	 */
	release(text: string, exact = false): string | undefined {
		const queued = this.queued.release(text);
		if (queued !== undefined) return queued ?? undefined;
		const at = this.idle.findIndex((entry) => entry.text === text);
		const index = at === -1 && !exact && this.idle.length > 0 ? 0 : at;
		return index === -1 ? undefined : this.idle.splice(index, 1)[0].payload;
	}

	clear(): void {
		this.queued.clear();
		this.idle = [];
	}
}
