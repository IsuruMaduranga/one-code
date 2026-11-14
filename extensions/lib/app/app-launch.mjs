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
import { brand, envName, productBrand, productStateDir } from "../profile/brand.mjs";

/** The app-only override for the app's pi agent directory. */
export const APP_AGENT_DIR_VAR = envName("AGENT_DIR");
/** JSON of each launcher variable's value before the launcher set it (null: unset). */
export const LAUNCHER_ENV_VAR = envName("LAUNCHER_ENV");
/** Where the launcher publishes how the app was installed (lib/app/update-check.mjs reads it). */
export const INSTALL_METHOD_VAR = envName("INSTALL_METHOD");
/** The variables the launcher sets for its own process. */
/** The variable the launcher passes the app's version in: its presence is how the base tells the bundled app from a plain pi package. */
export const VERSION_VAR = envName("VERSION");
/** pi's variable for where session transcripts are kept and looked up. */
export const SESSION_DIR_VAR = "PI_CODING_AGENT_SESSION_DIR";
/**
 * Whether the profile in force keeps its own transcripts: a product profile
 * with a state folder of its own (`.qa` beside the product's). Sign-in and
 * the model list stay in the product's agent directory; the transcripts go
 * to the profile's folder, so one profile's sessions are never listed or
 * resumed under another.
 */
export const OWN_SESSIONS = brand.stateDir !== productBrand.stateDir;
export const LAUNCHER_VARS = ["PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", VERSION_VAR, INSTALL_METHOD_VAR, ...(OWN_SESSIONS ? [SESSION_DIR_VAR] : [])];

/** Where the profile in force keeps its transcripts when it keeps its own: `<its state folder>/sessions`. pi files every project's sessions there and lists them by working directory. */
export function profileSessionDir(env = process.env, home = homedir()) {
	return join(productStateDir(env, home), "sessions");
}

/**
 * The app's pi agent directory: `ONECODE_AGENT_DIR`, else `~/.onecode/agent`. Never `PI_CODING_AGENT_DIR`.
 * It sits in the product's own folder whichever profile runs, so every
 * profile of a product shares one sign-in and model list. A product profile
 * with its own state folder keeps its transcripts there (`OWN_SESSIONS`).
 */
export function appAgentDir(env = process.env, home = homedir()) {
	return env[APP_AGENT_DIR_VAR] || join(home, productBrand.stateDir, "agent");
}

/**
 * How the app was installed, from the real path of its bin. Only a Homebrew
 * formula install lives in the formula's keg (`<prefix>/Cellar/onecode/<v>/…`);
 * `npm install -g` under Homebrew's own Node lands in `<prefix>/lib/node_modules`,
 * which is an npm install and upgrades with npm.
 */
export function installMethodFor(binRealPath) {
	const formula = brand.packages.homebrewFormula;
	if (!formula) return "npm";
	return String(binRealPath ?? "").replaceAll("\\", "/").includes(`/Cellar/${formula}/`) ? "brew" : "npm";
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
	if (OWN_SESSIONS) env[SESSION_DIR_VAR] = profileSessionDir(env, home);
	env.PI_SKIP_VERSION_CHECK = "1"; // the app ships its own update check
	env[VERSION_VAR] = appVersion; // the banner shows the app version
	env[INSTALL_METHOD_VAR] = installMethod;
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
