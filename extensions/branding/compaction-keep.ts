/**
 * pi's compaction keep window, at startup (lib/compaction-keep.mjs has the
 * rule and why).
 *
 * On the user's own pi, while neither the user's nor the project's settings set
 * `compaction.keepRecentTokens`, One Code asks once whether to set it to 0 in
 * the user's settings. "Yes" writes that one key (pi merges nested settings
 * key by key when it saves its own, so the value survives); pi reads it at
 * the next start. "No" is remembered in `~/.onecode/settings.json` and never
 * asked again; Escape asks again next start. An explicit value is the user's
 * and is never questioned; `/doctor` shows it. The bundled app sets 0 itself.
 */

import os from "node:os";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installKind } from "../doctor/builtins.ts";
import {
	compactionKeepView,
	KEEP_NO,
	KEEP_YES,
	keepWindowPrompt,
	ONE_CODE_KEEP_RECENT_TOKENS,
	withCompactionKeepBackfilled,
} from "../lib/compaction-keep.mjs";
import { readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";
import { tildify } from "../lib/paths.ts";
import { declined, recordDeclined } from "./declined.ts";

/** `~/.onecode/settings.json` key: the user answered "No" to the question. */
export const KEEP_DECLINED_KEY = "compactionKeepDeclined";

/** Ask once, when nothing sets the keep window. Never throws. */
export async function handleCompactionKeep(ctx: ExtensionContext): Promise<void> {
	try {
		if (installKind() === "app" || !ctx.hasUI || process.env.CC_COMPACTION === "0") return;
		if (declined(KEEP_DECLINED_KEY)) return;
		const agentDir = getAgentDir();
		const manager = SettingsManager.create(ctx.cwd, agentDir);
		const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		if (compactionKeepView(manager.getGlobalSettings(), manager.getProjectSettings(), modelKey).source !== "default") return;

		const userPath = join(agentDir, "settings.json");
		const choice = await ctx.ui.select(keepWindowPrompt(tildify(userPath, os.homedir())), [KEEP_YES, KEEP_NO]);
		if (choice === KEEP_YES) {
			const { settings, changed } = withCompactionKeepBackfilled(readSettingsForWrite(userPath));
			if (changed) writeSettings(userPath, settings);
			ctx.ui.notify(`Set compaction.keepRecentTokens to ${ONE_CODE_KEEP_RECENT_TOKENS}; /compact works on short sessions from the next start.`, "info");
		} else if (choice === KEEP_NO) {
			try {
				recordDeclined(KEEP_DECLINED_KEY);
			} catch (error) {
				ctx.ui.notify(`Could not remember the answer in ~/.onecode/settings.json: ${(error as Error).message}. One Code asks again next start.`, "warning");
			}
		}
	} catch (error) {
		try {
			ctx.ui.notify(`Could not set pi's compaction keep window: ${(error as Error).message}. Run /doctor for the settings change.`, "warning");
		} catch {
			// The session ended while the dialog was open: nothing is left to tell.
		}
	}
}
