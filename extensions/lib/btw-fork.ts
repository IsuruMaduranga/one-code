/**
 * The `/btw` panel's `f to fork` request, sent to the subagents extension over
 * pi.events (extensions share no module state). Claude Code's key spawns a
 * fork subagent: it inherits the conversation, then the side question and its
 * answer, takes the question as its task, runs in the background and reports
 * back as a task notification.
 *
 * The subagents extension sets `handled` synchronously inside its listener, so
 * the emitter can tell "nobody listens" (the extension is not loaded) from a
 * fork still starting; `respond` settles the request once.
 */

import type { Message } from "@earendil-works/pi-ai";

export const BTW_FORK_CHANNEL = "one-code:btw-fork";

/** The started fork, or why it could not start. */
export type BtwForkResult = { name: string; taskId: string } | { error: string };

export interface BtwForkRequest {
	/** The command context of the open panel (the listener reads cwd, session and model from it). */
	ctx: unknown;
	/** The side question: the fork's task. */
	question: string;
	/** The question and answer, appended to the fork's inherited conversation. */
	messages: Message[];
	/** Set by the listener before it returns. */
	handled?: boolean;
	respond: (result: BtwForkResult) => void;
}

/** Emit a fork request and wait for its answer; an error result when no listener took it. */
export function requestBtwFork(
	events: { emit(channel: string, data: unknown): void },
	request: Omit<BtwForkRequest, "respond" | "handled">,
): Promise<BtwForkResult> {
	return new Promise((resolve) => {
		const payload: BtwForkRequest = { ...request, respond: resolve };
		events.emit(BTW_FORK_CHANNEL, payload);
		if (!payload.handled) resolve({ error: "Forking needs the subagents extension, which is not loaded." });
	});
}

/**
 * The fork's base name, Claude Code's rule: the question's first three words,
 * hyphen-joined, lowercased, cut to `[a-z0-9-]` and 24 characters; `fork`
 * when nothing is left. "does reading outside project…" becomes
 * `does-reading-outside`. A taken name is suffixed by the caller.
 */
export function btwForkName(question: string): string {
	const slug = question
		.trim()
		.split(/\s+/)
		.slice(0, 3)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24);
	return slug || "fork";
}

/** Claude Code's transcript line for a started fork: `⑂ forked <name> (<last 4 of the id>)`. */
export function btwForkedLine(name: string, taskId: string): string {
	return `⑂ forked ${name} (${taskId.slice(-4)})`;
}

/**
 * The one-shot reminder the main conversation gets when a fork starts. The
 * side question never entered its context, so without this the fork's report
 * arrives as an answer to nothing the model asked for.
 */
export function btwForkReminder(name: string, taskId: string, question: string): string {
	return `The user forked a /btw side question into background agent ${name} (task ${taskId}). The question was: ${JSON.stringify(question)}. Its report will arrive as a task notification and answers that question; it is not a task you delegated.`;
}
