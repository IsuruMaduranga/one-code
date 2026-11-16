/**
 * Why the cache-reading compaction gave way to pi's own (pure). Any failure
 * returns nothing from `session_before_compact`, so pi's built-in summarizer
 * runs instead: a different summary style, never a broken compaction, but it
 * does not reuse the session's prompt cache. A failure that stays silent hides
 * an expired login or a wrong key on that path, so the extension logs every
 * fallback to the side-call log and tells the user once per session when the
 * cause is a credential, the provider or a fault of ours (index.ts).
 */

export type CompactionFallback =
	/** pi could not resolve the model's credentials. */
	| { kind: "credentials"; detail: string }
	/** The provider answered with an error (pi's setup errors, such as no credential, land here too). */
	| { kind: "provider"; detail: string }
	/** No reply within the compaction's own time limit. */
	| { kind: "timeout"; seconds: number }
	/** The call threw: a fault in our code or pi's, not a provider answer. */
	| { kind: "error"; detail: string }
	/** The summary ran past its output cap. */
	| { kind: "length" }
	/** The reply held no `<summary>` block. */
	| { kind: "noSummary" };

/** The fallback a finished call's reply means, or undefined when it is not one (a stop, or the user cancelled). */
export function replyFallback(reply: { stopReason: string; errorMessage?: string }, cancelled: boolean, timeoutMs: number): CompactionFallback | undefined {
	if (cancelled) return undefined;
	if (reply.stopReason === "error") return { kind: "provider", detail: reply.errorMessage || "the provider returned an error" };
	if (reply.stopReason === "aborted") return { kind: "timeout", seconds: Math.round(timeoutMs / 1000) };
	if (reply.stopReason === "length") return { kind: "length" };
	return undefined;
}

/** The fallback a thrown error means. */
export function thrownFallback(error: unknown): CompactionFallback {
	return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
}

/** One line for the side-call log. */
export function fallbackReason(fallback: CompactionFallback): string {
	switch (fallback.kind) {
		case "credentials":
			return `credentials: ${fallback.detail}`;
		case "provider":
			return `provider error: ${fallback.detail}`;
		case "timeout":
			return `no reply within ${fallback.seconds} seconds`;
		case "error":
			return `error: ${fallback.detail}`;
		case "length":
			return "the summary ran past its output cap";
		case "noSummary":
			return "the reply held no <summary> block";
	}
}

/**
 * The notice the user sees, once per session, or undefined for a fallback
 * that needs no action (a long summary, a reply without the block: the
 * model's own variance). `model` is `provider/id`.
 */
export function fallbackNotice(fallback: CompactionFallback, model: string): string | undefined {
	const after = "The built-in summarizer ran instead; it does not reuse the session's prompt cache. This notice shows once per session.";
	switch (fallback.kind) {
		case "credentials":
			return `Compaction could not use ${model}: ${fallback.detail}. ${after} Check the provider's login (/login) or API key.`;
		case "provider":
			return `Compaction on ${model} failed: ${fallback.detail}. ${after}`;
		case "timeout":
			return `Compaction on ${model} got no reply within ${fallback.seconds} seconds. ${after}`;
		case "error":
			return `Compaction on ${model} failed: ${fallback.detail}. ${after}`;
		case "length":
		case "noSummary":
			return undefined;
	}
}
