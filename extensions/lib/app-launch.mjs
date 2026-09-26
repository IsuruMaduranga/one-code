/**
 * The bundled app's process environment: where its pi state lives, how it was
 * installed, and what a child process may inherit. Shared by the launcher
 * (app/bin.mjs, which applies it before pi loads) and by every extension spawn
 * site (childProcessEnv). Plain JS with no pi imports, like update-check.mjs:
 * the launcher loads it from the extension package on bare Node.
 *
 * The app owns its pi directory unconditionally. A user-exported
 * `PI_CODING_AGENT_DIR` belongs to the user's own pi, so adopting it would
 * register One Code into that pi's settings and turn every plain `pi` run into
 * One Code. `ONECODE_AGENT_DIR` is the app's own knob.
 *
 * The variables the launcher sets describe the app process only. A `pi` a user
 * or the model starts from inside a session must see the user's own values, so
 * the launcher records what each variable held before (`ONECODE_LAUNCHER_ENV`)
 * and childProcessEnv restores that for every spawned command. A nested
 * `onecode` then re-derives its own values from a clean slate.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The app-only override for the app's pi agent directory. */
export const APP_AGENT_DIR_VAR = "ONECODE_AGENT_DIR";
/** JSON of each launcher variable's value before the launcher set it (null: unset). */
export const LAUNCHER_ENV_VAR = "ONECODE_LAUNCHER_ENV";
/** The variables the launcher sets for its own process. */
export const LAUNCHER_VARS = ["PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "CC_VERSION", "ONECODE_INSTALL_METHOD"];

/** The app's pi agent directory: `ONECODE_AGENT_DIR`, else `~/.onecode/agent`. Never `PI_CODING_AGENT_DIR`. */
export function appAgentDir(env = process.env, home = homedir()) {
	return env[APP_AGENT_DIR_VAR] || join(home, ".onecode", "agent");
}

/**
 * How the app was installed, from the real path of its bin. Only a Homebrew
 * formula install lives in the formula's keg (`<prefix>/Cellar/onecode/<v>/…`);
 * `npm install -g` under Homebrew's own Node lands in `<prefix>/lib/node_modules`,
 * which is an npm install and upgrades with npm.
 */
export function installMethodFor(binRealPath) {
	return /[\\/]Cellar[\\/]onecode[\\/]/.test(String(binRealPath ?? "")) ? "brew" : "npm";
}

/**
 * Set the launcher variables on `env` (process.env in the launcher), after
 * recording what each held, and return the app's agent directory. A record
 * already present is kept, so a second application in one process cannot
 * overwrite the user's values with the app's.
 */
export function applyLauncherEnv(env, { home = homedir(), appVersion, installMethod }) {
	if (env[LAUNCHER_ENV_VAR] === undefined) {
		const before = {};
		for (const name of LAUNCHER_VARS) before[name] = env[name] ?? null;
		env[LAUNCHER_ENV_VAR] = JSON.stringify(before);
	}
	const agentDir = appAgentDir(env, home);
	env.PI_CODING_AGENT_DIR = agentDir;
	env.PI_SKIP_VERSION_CHECK = "1"; // One Code ships its own update check
	env.CC_VERSION = appVersion; // the banner shows the app version
	env.ONECODE_INSTALL_METHOD = installMethod;
	return agentDir;
}

/**
 * The environment for a spawned command: `env` with the launcher variables put
 * back to the user's own values and the record removed. Outside the app (no
 * record) it is `env` itself, untouched. A record that does not parse drops the
 * launcher variables: a child of the app must never inherit the app's state.
 * Names match case-insensitively on Windows, where the environment does.
 */
export function childProcessEnv(env = process.env, platform = process.platform) {
	const record = env[LAUNCHER_ENV_VAR];
	if (record === undefined) return env;
	let before = {};
	try {
		const parsed = JSON.parse(record);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) before = parsed;
	} catch {
		// Unparseable: every launcher variable is dropped below.
	}
	const names = [LAUNCHER_ENV_VAR, ...LAUNCHER_VARS];
	const fold = platform === "win32" ? (name) => name.toUpperCase() : (name) => name;
	const drop = new Set(names.map(fold));
	const out = {};
	for (const [key, value] of Object.entries(env)) {
		if (!drop.has(fold(key))) out[key] = value;
	}
	for (const name of LAUNCHER_VARS) {
		const value = before[name];
		if (typeof value === "string") out[name] = value;
	}
	return out;
}
