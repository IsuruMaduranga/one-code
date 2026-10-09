/**
 * Cross-extension "a setting you own just changed on disk" channels (pure
 * constants). jiti isolates module state, so when one extension writes another
 * extension's setting — `/doctor preset` writing the subagent default — it
 * announces the write here and the owner re-reads its file and republishes its
 * live status. No payload: the owner's own loader is the source of truth.
 */

/** `subagentModel` in ~/.onecode/settings.json changed; the subagents extension re-resolves and re-emits its status. */
export const SUBAGENT_DEFAULT_CHANGED_CHANNEL = "one-code:subagent-default-changed";
