/**
 * A fork's permission mode, told as the parent's (lifecycle-grid-hunt round 3,
 * R3-L15). A fork's tool calls are checked by the parent's gate, in the
 * parent's live mode, but the fork has no permissions or plan-mode extension
 * of its own: its history shows the mode only as the sticky block it
 * inherited at spawn. So the mode is live state with a told fact, like every
 * capability owner's: at each request the fork renders, a mode that differs
 * from what the fork was told (or, before any notice, from the mode its
 * branch recorded at spawn) is announced on the tail, once.
 *
 * An inline child extension; the getter reads the parent's live mode.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readState } from "../lib/ledger/state.ts";
import { RENDER_CHANNEL, type RenderRequest, toldBlockFact } from "../lib/reminders.ts";
import { PERMISSION_MODE_STATE } from "../permissions/modes.ts";
import { normalizePermissionMode } from "../permissions/settings.ts";

/** The told fact's key. */
const PARENT_MODE_FACT = "parent-permission-mode";

export function parentModeText(mode: string): string {
	const plan = mode === "plan" ? " Only read-only tools run now: do not edit files or change state." : "";
	return `The main session's permission mode is now "${mode}", and your tool calls are checked against it from here on.${plan}`;
}

export function parentModeExtension(getMode: () => string) {
	return (pi: ExtensionAPI) => {
		/** The mode the fork's branch recorded: the parent's at spawn, which the inherited history shows. */
		let atSpawn: string | undefined;
		pi.on("session_start", (_event, ctx) => {
			atSpawn = normalizePermissionMode(readState(ctx, PERMISSION_MODE_STATE));
		});
		pi.events.on(RENDER_CHANNEL, (data) => {
			const request = data as RenderRequest;
			const live = getMode();
			const fact = toldBlockFact(PARENT_MODE_FACT, live);
			const told = request.toldBlocks.get(PARENT_MODE_FACT);
			if (told === fact.hash || (told === undefined && atSpawn === live)) return;
			request.blocks.push({ text: parentModeText(live), facts: [fact] });
		});
	};
}
