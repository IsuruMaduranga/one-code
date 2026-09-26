/**
 * Side channel for a bash call's ORIGINAL command in a worktree session.
 *
 * pi binds tools to the cwd captured at session creation, so the worktree
 * extension cd-wraps every bash command on `tool_call`. The permission
 * matcher, the classifier transcript, and bash's own guards must still see
 * what the model actually asked for — but that fact must never travel inside
 * `event.input`: pi validates tool arguments without `additionalProperties:
 * false`, so a key the model itself writes there survives to `tool_call`, and
 * a gate that read it would be matching rules against a string the model
 * chose (a fake `npm test` fronting a real `curl … | sh`). The wrapper
 * publishes the original over the bus keyed by pi's `toolCallId` — a value
 * the model cannot forge — and consumers look it up by that id. Each
 * consuming extension owns its own store (module state does not cross
 * extension boundaries, findings §3); multiple bus listeners are fine.
 */

/** `{ toolCallId, command, cwd }` — the pre-wrapper command of one bash call and the directory it runs in. */
export const ORIGINAL_COMMAND_CHANNEL = "one-code:bash-original-command";

export interface OriginalCommandRecord {
	toolCallId: string;
	command: string;
	/**
	 * The directory the wrapper `cd`s into (the worktree). The pre-gate runs on
	 * the original command against THIS cwd, so a worktree session keeps the
	 * containment fast path and the prompt shows the command the model wrote,
	 * not `cd '…' && (…)` (PERMISSIONS-REVIEW-2026-09-05 L3).
	 */
	cwd?: string;
}

/** Bounded so a long session cannot grow the map without limit. */
const MAX_ENTRIES = 256;

interface EventBusLike {
	events: { on(channel: string, handler: (payload: unknown) => void): unknown };
}

/** The published original of one call: the command and, when known, the directory it runs in. */
export interface OriginalCommand {
	command: string;
	cwd?: string;
}

export interface OriginalCommandStore {
	/** The model's original command (and its cwd) for this call id, when a wrapper published one. */
	get(toolCallId: string): OriginalCommand | undefined;
}

export function trackOriginalCommands(pi: EventBusLike): OriginalCommandStore {
	const byId = new Map<string, OriginalCommand>();
	pi.events.on(ORIGINAL_COMMAND_CHANNEL, (payload) => {
		const record = payload as Partial<OriginalCommandRecord> | undefined;
		if (typeof record?.toolCallId !== "string" || typeof record.command !== "string") return;
		byId.set(record.toolCallId, { command: record.command, cwd: typeof record.cwd === "string" ? record.cwd : undefined });
		if (byId.size > MAX_ENTRIES) {
			const oldest = byId.keys().next().value;
			if (oldest !== undefined) byId.delete(oldest);
		}
	});
	return { get: (toolCallId) => byId.get(toolCallId) };
}

/**
 * The command the gate and guards should evaluate: the published original
 * when this call was wrapped, otherwise the command as sent.
 */
export function commandToEvaluate(store: OriginalCommandStore, toolCallId: string, command: string): string {
	return store.get(toolCallId)?.command ?? command;
}
