/**
 * The one way a permission gate opens a prompt (pure; no pi imports).
 *
 * Every gate prompt (the permissions extension's asks, auto mode's fallback to
 * manual approval, the in-process child bridge's asks on the parent's
 * terminal, the outside-read and repository-trust questions, plan approval)
 * opens through `openGatePrompt`. It owns what each site used to repeat by
 * hand: an aborted signal or a session with no UI resolves `undefined` without
 * opening anything (the caller reads that as dismissed, so the gate fails
 * closed), and the description the desktop notifier names the prompt by is
 * announced only right before the prompt opens and withdrawn once it settles,
 * however it settles (answered, dismissed, aborted, or the opener threw).
 *
 * The caller keeps everything else: its queue (call this from inside it, so
 * the announcement follows the wait), the exact `ctx.ui` call in `open` (same
 * title, options, signal and timeout, so the RPC `extension_ui_request` is the
 * one the site always sent), and what the answer decides.
 */

import { announcePrompt } from "../notify/desktop.ts";

interface Emitter {
	emit(channel: string, data: unknown): void;
}

export interface GatePromptOptions<T> {
	/** The bus the desktop notifier listens on (`pi.events`). */
	events: Emitter;
	/** What the prompt waits for, named in the desktop notification; undefined leaves it undescribed. */
	attention: string | undefined;
	/** Aborted before the prompt opens: resolve `undefined` without opening it. */
	signal?: AbortSignal;
	/** Whether a UI can show the prompt now; false resolves `undefined` without opening it. Defaults to true. */
	hasUI?: () => boolean;
	/** Open the prompt: the site's own `ctx.ui.select` / `confirm` / `input` / `custom` call. */
	open: () => Promise<T>;
}

/** Open one gate prompt: `undefined` when aborted or with no UI, else what `open` resolves to. */
export async function openGatePrompt<T>(options: GatePromptOptions<T>): Promise<T | undefined> {
	const { events, attention, signal, hasUI, open } = options;
	if (signal?.aborted) return undefined;
	if (hasUI && !hasUI()) return undefined;
	const withdraw = attention !== undefined ? announcePrompt(events, attention) : undefined;
	try {
		return await open();
	} finally {
		// A prompt that opened took its description already (pi's
		// ui_prompt_start); one that never did must not describe the next.
		withdraw?.();
	}
}

/**
 * `openGatePrompt` bound to a bus and a context: call the result with what the
 * prompt waits for, the signal that cancels it, and the opener. The context is
 * read when the prompt opens, so a stale one fails there, not here.
 */
export function bindGatePrompt(events: Emitter, ctx: { hasUI: boolean }) {
	return <T>(attention: string | undefined, signal: AbortSignal | undefined, open: () => Promise<T>): Promise<T | undefined> =>
		openGatePrompt({ events, attention, signal, hasUI: () => ctx.hasUI, open });
}
