/**
 * Which of pi's built-in extensions that One Code replaces the running pi
 * still loads, read from pi's own settings (lib/replaced-builtins.mjs has the
 * rule). Shared by the startup notice (branding) and `/doctor`, in the
 * session and from `onecode doctor`.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { piHasBuiltinExtensions } from "../lib/pi-version.ts";
import { BUILTIN_EXTENSIONS_PI, type BuiltinLeftOn, builtinsLeftOn } from "../lib/replaced-builtins.mjs";

export interface ReplacedBuiltinsView {
	/** The replaced built-ins pi still loads; empty when the settings turn them all off. */
	left: BuiltinLeftOn[];
	/** The settings files a fix edits. */
	paths: { user: string; project: string };
}

/**
 * The view for a pi with the built-ins, or undefined on an older pi (nothing
 * to report) or when the settings cannot be read (pi reports that itself).
 */
export function replacedBuiltinsView(
	piVersion: string | undefined,
	settings: () => Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">,
	paths: { agentDir: string; cwd: string },
): ReplacedBuiltinsView | undefined {
	if (!piHasBuiltinExtensions(piVersion, BUILTIN_EXTENSIONS_PI)) return undefined;
	try {
		const manager = settings();
		return {
			left: builtinsLeftOn(manager.getGlobalSettings().extensions, manager.getProjectSettings().extensions),
			paths: { user: join(paths.agentDir, "settings.json"), project: join(paths.cwd, CONFIG_DIR_NAME, "settings.json") },
		};
	} catch {
		return undefined;
	}
}

/** Whether this is the bundled app (its launcher sets `CC_VERSION`) or One Code on the user's own pi. */
export function installKind(env: NodeJS.ProcessEnv = process.env): "app" | "pi-package" {
	return env.CC_VERSION ? "app" : "pi-package";
}

/** How the user opens pi's config UI: `onecode config` under the bundled app. */
export function configCommand(install: "app" | "pi-package"): string {
	return install === "app" ? "onecode config" : "pi config";
}
