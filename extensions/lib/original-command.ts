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

/** `{ toolCallId, command }` — the pre-wrapper command of one bash call. */
export const ORIGINAL_COMMAND_CHANNEL = "one-code:bash-original-command";

export interface OriginalCommandRecord {
	toolCallId: string;
	command: string;
}

/** Bounded so a long session cannot grow the map without limit. */
const MAX_ENTRIES = 256;

interface EventBusLike {
	events: { on(channel: string, handler: (payload: unknown) => void): unknown };
}

export interface OriginalCommandStore {
	/** The model's original command for this call id, when a wrapper published one. */
	get(toolCallId: string): string | undefined;
}

export function trackOriginalCommands(pi: EventBusLike): OriginalCommandStore {
	const byId = new Map<string, string>();
	pi.events.on(ORIGINAL_COMMAND_CHANNEL, (payload) => {
		const record = payload as Partial<OriginalCommandRecord> | undefined;
		if (typeof record?.toolCallId !== "string" || typeof record.command !== "string") return;
		byId.set(record.toolCallId, record.command);
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
	return store.get(toolCallId) ?? command;
}
