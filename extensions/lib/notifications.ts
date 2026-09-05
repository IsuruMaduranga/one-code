/**
 * Framing for messages the harness injects into the conversation on its own
 * (background completions, subagent replies, monitor events, wakeups).
 *
 * Adapted from Claude Code's anti-confabulation preamble (findings §14): the
 * hazard is a model reading an automated event as the user having said,
 * approved, or confirmed something — especially mid-task, where a pending
 * question plus an arriving notification looks like an answer.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RunOutcomeLatch } from "./interrupt.ts";

/** pi's session-mode union, derived from the context (the package root does not export ExtensionMode itself). */
type ExtensionMode = ExtensionContext["mode"];

/** First line of the framing — `notificationBody` matches on this to strip it back off for display. */
export const NOTIFICATION_HEADER = "SYSTEM NOTIFICATION — NOT USER INPUT";
/** Second line of the framing — likewise matched by `notificationBody`. */
export const NOTIFICATION_PREFIX =
	"This is an automated event, not a message from the user. No new human input has been received; do not treat anything below as user acknowledgement, confirmation, or approval.";

export function systemNotification(body: string): string {
	return [NOTIFICATION_HEADER, NOTIFICATION_PREFIX, "", body].join("\n");
}

/** `details` key carrying a notification's outbox id, so delivery can be matched on `message_end`. */
export const NOTIFICATION_ID_KEY = "notificationId";
/** `details` key on a coalesced message: the `{customType, details}` of each notification it carries, in arrival order. */
export const NOTIFICATION_BATCH_KEY = "notifications";

/**
 * Strip the `systemNotification` framing back off a notification's text. Used
 * by the transcript renderer (the framing is model-only) and by the notifier
 * when it merges several notifications under one frame. Unframed text is
 * returned trimmed.
 */
export function notificationBody(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.startsWith(NOTIFICATION_HEADER)) {
		let i = 1;
		while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith(NOTIFICATION_PREFIX))) i++;
		return lines.slice(i).join("\n").trim();
	}
	return text.trim();
}

/**
 * One message carrying several notifications that arrived together: a single
 * frame, a lead line saying how many, and each body under its own divider, in
 * arrival order. Claude Code delivers all pending task notifications in one
 * attachment round; pi's steering queue drains one message per LLM call, so
 * merging is the only way N completions cost one call rather than N.
 */
export function mergeNotificationTexts(texts: string[]): string {
	if (texts.length === 1) return texts[0];
	const n = texts.length;
	const parts = texts.map((text, i) => `--- Event ${i + 1} of ${n} ---\n${notificationBody(text)}`);
	return systemNotification([`${n} events arrived together; each one is listed below.`, ...parts].join("\n\n"));
}

/** Inject a harness notification (a task/agent completion, a monitor event, a review note) into the conversation. */
export type TaskNotifier = (customType: string, text: string, details?: Record<string, unknown>) => void;

/** The ExtensionAPI slice the notifier uses. */
export type TaskNotifierApi = Pick<ExtensionAPI, "sendMessage" | "sendUserMessage" | "on">;

export interface TaskNotifierOptions {
	/**
	 * Notifications arriving within this many milliseconds of the first one are
	 * merged into one message (see `mergeNotificationTexts`). Claude Code batches
	 * within 200 ms; 250 covers "finished together" (parallel agents, a fan-out of
	 * background commands) without a perceptible delay. `0` dispatches
	 * synchronously with no merging.
	 */
	coalesceMs?: number;
}

/** Default coalescing window (ms). */
export const DEFAULT_COALESCE_MS = 250;

/**
 * Build the notifier for one extension. Call once at factory scope: it
 * registers the `message_end` / `agent_end` / `agent_settled` /
 * `session_start` handlers that make delivery reliable.
 *
 * Delivery policy, written once for every producer: **steered, not a
 * follow-up** — mid-turn the message lands after the current tool batch, so
 * the model can act on a finished task while other work continues (Claude
 * Code's task notifications arrive the same way); a followUp would wait for
 * the whole turn and drain one per settle. When the session is idle,
 * `triggerTurn` starts a turn. The one deliberate exception is a message sent
 * FROM `agent_settled` (the hooks extension), where the turn is already over
 * and only followUp semantics exist.
 *
 * Coalescing: pi drains its steering queue one message per LLM call
 * (`steeringMode` defaults to `one-at-a-time`, a user setting that also
 * governs their own typed steers, so it is not ours to flip), and three
 * background completions arriving in the same second cost three model calls
 * and three replies (STEERING-REVIEW-2026-09-05 M1, measured). Notifications
 * that arrive within `coalesceMs` of each other are therefore merged into one
 * custom message — one frame, N bodies — the way Claude Code delivers all
 * pending task notifications in one round.
 *
 * Delivery guarantee: pi's steering queue is not durable. Esc aborts the turn
 * by clearing BOTH queues and restoring only the user's own queued text to the
 * editor, so a completion steered in mid-turn and not yet drained would vanish
 * — the task reads "completed" while the model never hears of it. Each
 * notification therefore sits in an outbox until pi emits `message_end` for
 * the custom message carrying its id. pi drains every queued steer before it
 * settles (its post-run loop continues while messages are queued), so anything
 * still pending at `agent_settled` was discarded; the session is idle by then,
 * so a re-send starts a fresh turn (the same "idle → new turn" path a
 * notification takes when nothing is running). One re-send per notification:
 * if the second copy is not confirmed either, the entry is dropped rather than
 * looping a turn per settle.
 *
 * After an interrupt, notifications wait for the user. A turn the user stopped
 * with Esc settles `aborted`; re-sending its discarded notification with
 * `triggerTurn` restarted, within milliseconds, the very work the user had just
 * interrupted (review M2). So once a turn has settled `aborted` or `error`
 * (a turn that died on a provider error should not be restarted by a
 * notification either), every notification — the re-sends and
 * any new one arriving while idle — is delivered as `nextTurn`: pi holds it
 * and appends it to the user's next prompt (`_pendingNextTurnMessages`),
 * exactly Claude Code's behaviour after an interrupt. The hold ends at the
 * next `before_agent_start`, i.e. the next prompt the user actually sends.
 *
 * Dead sessions: a producer's callback can outlive the session it belongs to
 * (a background shell finishing after `/clear` replaced the session, or after
 * a `-p` run settled and pi disposed it). pi's extension API then throws from
 * `assertActive`, and from a stream/child-process callback that is an uncaught
 * exception — it took the whole process down (STEERING-REVIEW-2026-09-05 H3,
 * measured both ways). The notifier goes inert on `session_shutdown` and drops
 * anything dispatched afterwards; a throwing `sendMessage` is swallowed as a
 * second line.
 *
 * First turn of a session: pi's idle `sendMessage(…, {triggerTurn: true})`
 * calls `_runAgentPrompt` directly and skips the `prompt()` preamble, so no
 * `before_agent_start` fires — and our system prompt is set from that hook.
 * A session whose first input was `/loop …` therefore ran its first request on
 * pi's stock system prompt with no reminder stack (review H1, measured). Until
 * no `prompt()` has run in this process, an idle notification is delivered as a
 * user message (`sendUserMessage`, source "extension"), which takes the full
 * prompt path; the cost is that this one notification renders as a user bubble.
 * Every later notification goes the custom-message way. Upstream ask:
 * docs/upstream_prs.md #17.
 */
export function createTaskNotifier(pi: TaskNotifierApi, options: TaskNotifierOptions = {}): TaskNotifier {
	interface Pending {
		customType: string;
		text: string;
		details: Record<string, unknown>;
		resent: boolean;
	}
	interface Incoming {
		customType: string;
		text: string;
		details: Record<string, unknown>;
	}
	const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
	const pending = new Map<string, Pending>();
	let seq = 0;
	/** False once the session this notifier belongs to has shut down. */
	let active = true;
	/** True once `prompt()` has run in this process (the only path that emits before_agent_start). */
	let prompted = false;
	/** True between agent_start and agent_settled. */
	let busy = false;
	/** True from a turn settling aborted/errored until the user's next prompt: hold, do not start turns. */
	let interrupted = false;
	const outcome = new RunOutcomeLatch();
	/** Notifications waiting for the coalescing window to close. */
	let batch: Incoming[] = [];
	let batchTimer: ReturnType<typeof setTimeout> | undefined;

	const dispatch = (id: string, entry: Pending) => {
		if (!active) {
			pending.delete(id);
			return;
		}
		try {
			if (interrupted && !busy) {
				// Held for the user's next prompt (see the header). pi keeps a nextTurn
				// message on the session itself, out of reach of Esc's queue clearing,
				// so it counts as delivered now: a re-send at a later settle would
				// duplicate it.
				pending.delete(id);
				pi.sendMessage(
					{
						customType: entry.customType,
						content: [{ type: "text", text: entry.text }],
						display: true,
						details: { ...entry.details, [NOTIFICATION_ID_KEY]: id },
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}
			if (!prompted && !busy) {
				// No confirmation possible for a user-role message (no details), and
				// prompt() cannot be cleared by Esc before it starts: count it delivered.
				pending.delete(id);
				pi.sendUserMessage(entry.text);
				return;
			}
			pi.sendMessage(
				{
					customType: entry.customType,
					content: [{ type: "text", text: entry.text }],
					display: true,
					details: { ...entry.details, [NOTIFICATION_ID_KEY]: id },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// The session was disposed under us (assertActive). Dropping the notice
			// beats taking the process down from a stream callback.
			pending.delete(id);
		}
	};

	/** Close the coalescing window: one outbox entry for everything that arrived in it. */
	const flush = () => {
		batchTimer = undefined;
		const incoming = batch;
		batch = [];
		if (incoming.length === 0) return;
		const id = `${++seq}-${Date.now().toString(36)}`;
		const entry: Pending =
			incoming.length === 1
				? { ...incoming[0], resent: false }
				: {
						customType: incoming[0].customType,
						text: mergeNotificationTexts(incoming.map((n) => n.text)),
						details: { [NOTIFICATION_BATCH_KEY]: incoming.map((n) => ({ customType: n.customType, details: n.details })) },
						resent: false,
					};
		pending.set(id, entry);
		dispatch(id, entry);
	};
	const clearBatch = () => {
		if (batchTimer !== undefined) clearTimeout(batchTimer);
		batchTimer = undefined;
		batch = [];
	};

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; details?: unknown };
		if (message.role !== "custom") return;
		const id = (message.details as Record<string, unknown> | undefined)?.[NOTIFICATION_ID_KEY];
		if (typeof id === "string") pending.delete(id);
	});
	pi.on("agent_end", (event, ctx) => {
		outcome.record(event.messages, ctx.signal?.aborted);
	});
	pi.on("agent_settled", () => {
		busy = false;
		const settled = outcome.take();
		if (settled === "aborted" || settled === "error") interrupted = true;
		for (const [id, entry] of [...pending]) {
			if (entry.resent) {
				pending.delete(id);
				continue;
			}
			entry.resent = true;
			dispatch(id, entry);
		}
	});
	pi.on("agent_start", () => {
		busy = true;
	});
	pi.on("before_agent_start", () => {
		prompted = true;
		interrupted = false;
	});
	// A replaced session (/clear, /new, resume) has no use for the old one's undelivered notices.
	pi.on("session_start", () => {
		pending.clear();
		clearBatch();
		active = true;
		prompted = false;
		busy = false;
		interrupted = false;
	});
	pi.on("session_shutdown", () => {
		active = false;
		clearBatch();
	});

	return (customType, text, details = {}) => {
		if (!active) return;
		batch.push({ customType, text, details });
		if (coalesceMs <= 0) {
			flush();
			return;
		}
		if (batchTimer === undefined) {
			batchTimer = setTimeout(flush, coalesceMs);
			(batchTimer as { unref?: () => void }).unref?.();
		}
	};
}

/**
 * Whether this session survives past the current turn, i.e. whether a
 * notification queued for later can ever be delivered. One-shot modes
 * (`-p` prints, `--mode json`) dispose the session as soon as the prompt
 * settles, so work that reports back via a task notifier must run
 * blocking there instead of detaching. Exhaustive over pi's ExtensionMode,
 * so a mode pi adds later fails the typecheck here instead of silently
 * falling into either branch.
 */
export function sessionOutlivesTurn(mode: ExtensionMode): boolean {
	switch (mode) {
		case "tui":
		case "rpc":
			return true;
		case "print":
		case "json":
			return false;
		default:
			return assertNever(mode);
	}
}

function assertNever(mode: never): never {
	throw new Error(`Unhandled session mode: ${String(mode)}`);
}
