/**
 * pi's built-in extensions that One Code replaces.
 *
 * pi 0.99 ships `tool-search` and `mcp` as built-in extensions and skips one
 * when another extension registers one of its names: our `tool_search` tool
 * and our `/mcp` command. pi then warns at every start, even with
 * `quietStartup`, and the warning ends by advising the user to "disable or
 * remove the existing extension", meaning One Code (findings §44, §45). Only
 * the `extensions` setting turns a built-in off without the warning, so the
 * bundled app writes `-builtin:<name>` into its own settings, and on the
 * user's own pi a startup notice and `/doctor` say how (decisions/tools.md,
 * "pi's built-in tool search and MCP").
 *
 * Plain JS with no pi imports, like app-launch.mjs: app/bin.mjs loads it on
 * bare Node before pi does.
 */

/** pi's built-in extensions One Code replaces, and what of ours replaces each. */
export const REPLACED_BUILTINS = [
	{ name: "tool-search", ours: "tool search" },
	{ name: "mcp", ours: "MCP" },
];

/** pi version that first ships the built-ins (`builtin:<name>` extension paths). */
export const BUILTIN_EXTENSIONS_PI = "0.99.0";

const PREFIX = "builtin:";

function entriesOf(extensions) {
	return Array.isArray(extensions) ? extensions.filter((entry) => typeof entry === "string") : [];
}

/**
 * pi's `!` patterns are minimatch globs. Callers that can reach pi's own
 * minimatch pass it as `matches` (doctor/builtins.ts); this port is the
 * fallback. A built-in path has no `/`, so it covers `*`, `?`, `[...]`
 * (`[!...]` negated) and `{a,b}` alternatives, nested, but not extglobs such
 * as `@(a|b)`.
 */
export function globMatches(pattern, path) {
	let source = "";
	let depth = 0;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "[" && pattern.indexOf("]", i + 2) !== -1) {
			const end = pattern.indexOf("]", i + 2);
			const body = pattern.slice(i + 1, end);
			const negated = body.startsWith("!") || body.startsWith("^");
			source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&")}]`;
			i = end;
		} else if (char === "{") {
			depth++;
			source += "(?:";
		} else if (char === "}" && depth > 0) {
			depth--;
			source += ")";
		} else if (char === "," && depth > 0) source += "|";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	if (depth > 0) return false; // an unclosed brace: minimatch reads it literally, and no built-in name has one
	return new RegExp(`^${source}$`).test(path);
}

/**
 * Whether one setting's override entries turn `path` on (true), off (false),
 * or leave it alone (undefined), in pi's order: `!glob` off, then an exact
 * `+path` on, then an exact `-path` off (`isEnabledByOverrides`).
 */
function overrideFor(path, entries, matches) {
	let result;
	for (const entry of entries) {
		if (entry.startsWith("!") && matches(entry.slice(1), path)) result = false;
	}
	if (entries.includes(`+${path}`)) result = true;
	if (entries.includes(`-${path}`)) result = false;
	return result;
}

/**
 * Whether pi loads built-in `name`, and whether the project's setting is what
 * turns it on: on unless the user's `extensions` setting turns it off, with a
 * matching entry in the project's setting winning (pi's package manager, the
 * `builtinExtensions` loop).
 */
function builtinState(name, userExtensions, projectExtensions, matches) {
	const path = `${PREFIX}${name}`;
	const project = overrideFor(path, entriesOf(projectExtensions), matches);
	return { enabled: project ?? overrideFor(path, entriesOf(userExtensions), matches) ?? true, byProject: project === true };
}

/** Whether pi loads built-in `name` (`builtinState`); `matches(pattern, path)` reads a `!` glob. */
export function builtinEnabled(name, userExtensions, projectExtensions, matches = globMatches) {
	return builtinState(name, userExtensions, projectExtensions, matches).enabled;
}

/**
 * The replaced built-ins pi still loads, each with the scope that keeps it on:
 * `project` when the project's setting turns it on, else `user`.
 */
export function builtinsLeftOn(userExtensions, projectExtensions, matches = globMatches) {
	const left = [];
	for (const { name, ours } of REPLACED_BUILTINS) {
		const { enabled, byProject } = builtinState(name, userExtensions, projectExtensions, matches);
		if (enabled) left.push({ name, ours, scope: byProject ? "project" : "user" });
	}
	return left;
}

/**
 * The app's user `extensions` setting with every replaced built-in turned off,
 * except one the user already has a `+` or `-` entry for: that is their
 * choice. `changed` is false when nothing was added.
 */
export function withReplacedBuiltinsOff(userExtensions) {
	const entries = entriesOf(userExtensions);
	const names = REPLACED_BUILTINS.map((builtin) => builtin.name).filter(
		(name) => !entries.includes(`+${PREFIX}${name}`) && !entries.includes(`-${PREFIX}${name}`),
	);
	return { extensions: withBuiltinsTurnedOff(userExtensions, names), changed: names.length > 0 };
}

/** "tool-search and mcp" for a list of built-ins. */
function nameList(left) {
	const names = left.map((builtin) => builtin.name);
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The startup notice for built-ins pi still loads, or undefined when none is.
 * `configCommand` is how the user reaches pi's config UI (`pi config`, or
 * `onecode config` under the app).
 */
export function replacedBuiltinsNotice(left, configCommand = "pi config") {
	if (left.length === 0) return undefined;
	const ours = left.map((builtin) => builtin.ours).join(" and ");
	const names = nameList(left);
	const plural = left.length > 1;
	return (
		`One Code provides its own ${ours}, so pi skips its built-in ${names} ${plural ? "extensions" : "extension"} and warns about ${plural ? "them" : "it"} at startup. ` +
		`Keep One Code installed. To hide the ${plural ? "warnings" : "warning"}, run \`${configCommand}\` and turn off ${names} under Built-in, or run /doctor to have it done for you.`
	);
}

/**
 * The exact settings change that turns the built-ins off, for `/doctor`'s fix
 * line: the user file gets `-builtin:<name>` entries, and a project entry
 * that turns one back on has to go.
 */
export function replacedBuiltinsFix(left, paths, configCommand = "pi config") {
	const user = left.filter((builtin) => builtin.scope === "user");
	const project = left.filter((builtin) => builtin.scope === "project");
	const steps = [];
	if (user.length > 0) {
		const entries = user.map((builtin) => `"-${PREFIX}${builtin.name}"`).join(" and ");
		steps.push(`add ${entries} to the "extensions" array in ${paths.user} (or run \`${configCommand}\` and turn ${nameList(user)} off under Built-in)`);
	}
	if (project.length > 0) {
		const entries = project.map((builtin) => `"+${PREFIX}${builtin.name}"`).join(" and ");
		steps.push(`remove ${entries} from the "extensions" array in ${paths.project}`);
	}
	const text = steps.join("; then ");
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}. It takes effect at the next start.`;
}

/**
 * The user `extensions` setting with `names` turned off: each one's `+` entry
 * removed and a `-` entry added (the consent path: the user said yes, so a
 * `+` entry of theirs is replaced, unlike `withReplacedBuiltinsOff`).
 */
export function withBuiltinsTurnedOff(userExtensions, names) {
	const turnOn = new Set(names.map((name) => `+${PREFIX}${name}`));
	const entries = (Array.isArray(userExtensions) ? userExtensions : []).filter((entry) => !turnOn.has(entry));
	for (const name of names) {
		if (!entries.includes(`-${PREFIX}${name}`)) entries.push(`-${PREFIX}${name}`);
	}
	return entries;
}

export const TURN_OFF_YES = "Yes, turn them off";
export const TURN_OFF_NO = "No, keep pi's built-ins on";

/**
 * The one-time question on the user's own pi, saying why: what pi's warning
 * means, what turning the built-ins off changes, and how to undo it.
 */
export function turnOffPrompt(left, settingsPath, configCommand = "pi config") {
	const names = nameList(left);
	const plural = left.length > 1;
	const ours = left.map((builtin) => builtin.ours).join(" and ");
	return [
		`Turn off pi's built-in ${names}?`,
		"",
		`pi ${plural ? "ships these" : "ships this"} as built-in ${plural ? "extensions" : "extension"}. One Code brings its own ${ours} (Claude Code's tool search, and MCP that reads your Claude Code config), so pi already skips ${plural ? "them" : "it"} and warns about ${plural ? "each" : "it"} at every start, telling you to remove One Code.`,
		"",
		`Turning ${plural ? "them" : "it"} off changes nothing while One Code is installed and silences the ${plural ? "warnings" : "warning"} from the next start. One Code adds ${left.map((builtin) => `"-${PREFIX}${builtin.name}"`).join(" and ")} to "extensions" in ${settingsPath}. If you remove One Code later, turn ${plural ? "them" : "it"} back on with \`${configCommand}\`.`,
	].join("\n");
}
