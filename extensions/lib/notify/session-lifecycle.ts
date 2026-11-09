/**
 * "Is this extension instance's session still alive?" — the one flag every
 * extension with late work (a child's `close`, a debounce, a panel action's
 * continuation) needs. After `session_shutdown` (which `/clear`, `/new`,
 * `/resume` and process exit all emit — findings §8) every `pi.*` call and
 * every getter on a captured ctx throws; a callback that fires afterwards must
 * do nothing. Before this module each extension kept its own `shuttingDown`
 * boolean wired to the same two events (LIFECYCLE-REVIEW-2026-09-06 fix pass).
 *
 * Call it FIRST in the factory: its handlers register before the extension's
 * own, so `alive()` already reads false inside the extension's
 * `session_shutdown` handler and true again inside its `session_start` one
 * (RPC's `new_session` re-runs factories and emits `session_start` twice;
 * the reset is idempotent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function sessionAlive(pi: Pick<ExtensionAPI, "on">): () => boolean {
	let alive = true;
	pi.on("session_start", () => {
		alive = true;
	});
	pi.on("session_shutdown", () => {
		alive = false;
	});
	return () => alive;
}
