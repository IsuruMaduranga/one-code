/**
 * pi 0.99's built-in tool search and MCP, at startup (lib/replaced-builtins.mjs
 * has the rule; decisions/tools.md "pi's built-in tool search and MCP").
 *
 * On the user's own pi, while the user's settings leave a built-in on, One
 * Code asks once whether to turn them off, explaining why. "Yes" writes the
 * `-builtin:<name>` entries through pi's own SettingsManager (a locked write
 * of the `extensions` field only, so pi's in-memory settings keep theirs).
 * "No" is remembered in `~/.onecode/settings.json` and never asked again;
 * Escape asks again next start. Without a yes, the one-line notice answers
 * pi's warning instead. Under the bundled app, which turns them off itself,
 * a built-in left on is the user's own `+` entry, so only the notice shows.
 */

import os from "node:os";
import { type ExtensionContext, getAgentDir, SettingsManager, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { configCommand, installKind, replacedBuiltinsView } from "../doctor/builtins.ts";
import { oneCodeSettingsPath, readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";
import { tildify } from "../lib/paths.ts";
import { replacedBuiltinsNotice, TURN_OFF_NO, TURN_OFF_YES, turnOffPrompt, withBuiltinsTurnedOff } from "../lib/replaced-builtins.mjs";

/** `~/.onecode/settings.json` key: the user answered "No" to the question. */
export const DECLINED_KEY = "piBuiltinsTurnOffDeclined";

function declined(): boolean {
	try {
		return readSettingsForWrite(oneCodeSettingsPath(os.homedir()))[DECLINED_KEY] === true;
	} catch {
		return false;
	}
}

function recordDeclined(): void {
	const path = oneCodeSettingsPath(os.homedir());
	writeSettings(path, { ...readSettingsForWrite(path), [DECLINED_KEY]: true });
}

/** Ask, or show the notice, for the built-ins the settings leave on. Never throws. */
export async function handleReplacedBuiltins(ctx: ExtensionContext): Promise<void> {
	try {
		const cwd = ctx.cwd;
		const agentDir = getAgentDir();
		const settings = () => SettingsManager.create(cwd, agentDir);
		const view = replacedBuiltinsView(PI_VERSION, settings, { agentDir, cwd });
		if (!view || view.left.length === 0) return;
		const install = installKind();
		const command = configCommand(install);
		const notice = () => {
			const text = replacedBuiltinsNotice(view.left, command);
			if (text) ctx.ui.notify(text, "info");
		};
		// Only the user's own file is ours to offer: a project's `+builtin` entry stays.
		const userScoped = view.left.filter((builtin) => builtin.scope === "user");
		if (install === "app" || !ctx.hasUI || userScoped.length === 0 || declined()) return notice();

		const shown = tildify(view.paths.user, os.homedir());
		const choice = await ctx.ui.select(turnOffPrompt(userScoped, shown, command), [TURN_OFF_YES, TURN_OFF_NO]);
		if (choice === TURN_OFF_YES) {
			const manager = settings();
			manager.setExtensionPaths(withBuiltinsTurnedOff(manager.getGlobalSettings().extensions, userScoped.map((builtin) => builtin.name)) as string[]);
			await manager.flush();
			const turnedOff = `Turned off pi's built-in ${userScoped.map((builtin) => builtin.name).join(" and ")} in ${shown}.`;
			// A project's `+builtin` entry still wins over the user's file, so its warning stays.
			const projectScoped = view.left.filter((builtin) => builtin.scope === "project");
			const rest =
				projectScoped.length === 0
					? "pi's warnings stop from the next start."
					: `This project's settings keep ${projectScoped.map((builtin) => builtin.name).join(" and ")} on, so pi still warns about ${projectScoped.length > 1 ? "them" : "it"}; run /doctor for that change.`;
			ctx.ui.notify(`${turnedOff} ${rest}`, "info");
			return;
		}
		if (choice === TURN_OFF_NO) recordDeclined();
		notice();
	} catch (error) {
		try {
			ctx.ui.notify(`Could not turn off pi's built-in tool search and MCP: ${(error as Error).message}. Run /doctor for the settings change.`, "warning");
		} catch {
			// The session ended while the dialog was open: nothing is left to tell.
		}
	}
}
