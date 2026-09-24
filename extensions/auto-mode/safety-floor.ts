/**
 * Auto mode's deterministic floor for writes to the gate's own controls (pure
 * apart from fs reads during path resolution).
 *
 * The classifier's hard-deny rules forbid tampering with permission settings,
 * but a rule the classifier enforces is only as strong as the classifier — a
 * weak model, or one talked around, could approve the one write that disables
 * every check after it. So writes to the files the gate is *made of* never
 * reach the classifier at all: interactively they always prompt the user, and
 * non-interactively they block.
 *
 * This is the deny-direction complement of the shell pre-gate, and the same
 * asymmetry applies inverted: the pre-gate may only ever say "safe" because a
 * gap there must cost a classifier call rather than become a bypass; this
 * floor may only ever say "stop" because a gap here merely falls through to
 * the classifier, which retains its tampering rules. Neither list has to be
 * complete to be sound — a `sed -i` on settings.json that the shell evidence
 * does not model as a write is the classifier's to catch, as today.
 *
 * The target list is deliberately exact files, not directories: ~/.claude also
 * holds memory and skills that the agent writes routinely, and a floor that
 * fires on routine work teaches the user to approve without reading.
 */

import { analyzeShellCommand, globComponentRegex, isUnknownTilde, LOOPS, parseCommand, resolvePayload, scopedTracker } from "./shell-analysis.ts";
import { autoModeSettingsPaths } from "./config.ts";
import { oneCodeProjectSettingsPath } from "../lib/one-code-settings.ts";
import { claudeJsonPath, comparablePath } from "../lib/paths.ts";
import { isWritingTool, resolveForContainment, toAbsolute, toAbsoluteBash } from "./paths.ts";

/** The same comparison form resolveForContainment's output is in (lib/paths.ts). */
const fold = comparablePath;

/**
 * Any `.claude/settings.json` or `.claude/settings.local.json`, wherever it
 * lives: the session reads them from cwd, but another checkout or worktree of
 * the same repo feeds other sessions, and prompting on a write to one of those
 * costs one question.
 */
const SETTINGS_TAIL = /\/\.claude\/settings(\.local)?\.json$/;

/**
 * One Code's own settings files — the global `~/.onecode/settings.json` and the
 * per-repo `~/.onecode/projects/<slug>/settings.json`, wherever `.onecode`
 * lives. Both now carry `permissions.allow` rules that `loadPermissionSettings`
 * reads and that bypass the classifier, so a write to either is a gate-control
 * write and must hit this floor rather than the auto-mode classifier (the global
 * file is also reached via `autoModeSettingsPaths`; this covers the per-repo one,
 * which that list never includes, and both under any checkout).
 */
const ONECODE_SETTINGS_TAIL = /\/\.onecode\/(projects\/[^/]+\/)?settings\.json$/;

function safetyControlFiles(home: string, oneCodeProjectSettings?: string): string[] {
	return [
		// autoMode + user permission rules, and the managed-settings paths (the
		// global ~/.onecode/settings.json here honours ONECODE_STATE_DIR).
		...autoModeSettingsPaths(home),
		// Claude Code's global state file also carries permission configuration;
		// claudeJsonPath honours CLAUDE_CONFIG_DIR so a relocated file is still caught.
		claudeJsonPath(home),
		// The per-repo One Code settings file also carries permission rules. The
		// tail regex catches it under a literal `.onecode`; this catches it when
		// ONECODE_STATE_DIR relocated the state root (review L2).
		...(oneCodeProjectSettings ? [oneCodeProjectSettings] : []),
	];
}

/**
 * Whether a *resolved* path (resolveForContainment output) is a gate control.
 * `oneCodeProjectSettings` is the current repo's One Code settings file, resolved
 * by the caller (once per session) so this need not re-walk for the project root.
 */
export function isSafetyControlTarget(resolved: string, home: string, oneCodeProjectSettings?: string): boolean {
	return matchesControlFile(resolved, controlFileForms(home, oneCodeProjectSettings));
}

/**
 * Every comparison form of the control files: each resolved like a write
 * target, or the two sides can disagree about the same file (macOS /var →
 * /private/var), plus its literal spelling.
 */
function controlFileForms(home: string, oneCodeProjectSettings?: string): Set<string> {
	const forms = new Set<string>();
	for (const file of safetyControlFiles(home, oneCodeProjectSettings)) {
		forms.add(resolveForContainment(file) ?? fold(file));
		forms.add(fold(file));
	}
	return forms;
}

function matchesControlFile(resolved: string, forms: ReadonlySet<string>): boolean {
	const target = fold(resolved);
	return SETTINGS_TAIL.test(target) || ONECODE_SETTINGS_TAIL.test(target) || forms.has(target);
}

const GLOB_CHARS = /[*?[]/;

/**
 * Whether a resolved shell path names a control file, literally or as a glob
 * the shell expands onto one (`> .claude/settings.*`, `.claude/s*.json`). A
 * glob leaf is tried against every control file name in its directory; a glob
 * in a directory component stops whenever the leaf could spell a control
 * file's name, since the floor may only ever say "stop". `dotRule` is bash's:
 * a leaf not starting with `.` never matches a name that does.
 */
function namesControlFile(resolved: string, forms: ReadonlySet<string>, dotRule: boolean): boolean {
	if (matchesControlFile(resolved, forms)) return true;
	const target = fold(resolved);
	if (!GLOB_CHARS.test(target)) return false;
	const slash = target.lastIndexOf("/");
	const dir = target.slice(0, slash);
	const leaf = target.slice(slash + 1);
	// An uncompilable bracket expression matches nothing: the shell writes the literal name.
	const regex = globComponentRegex(leaf);
	if (!regex) return false;
	const names = new Set(["settings.json", "settings.local.json"]);
	for (const form of forms) names.add(form.slice(form.lastIndexOf("/") + 1));
	const spelled = [...names].filter((name) => regex.test(name) && !(dotRule && name.startsWith(".") && !leaf.startsWith(".")));
	if (spelled.length === 0) return false;
	return GLOB_CHARS.test(dir) || spelled.some((name) => matchesControlFile(`${dir}/${name}`, forms));
}

export interface FloorInput {
	/** Already-normalized tool name (see permissions/matcher.ts). */
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	home: string;
	/**
	 * The current repo's One Code settings file, resolved once per session by the
	 * caller. When omitted it is derived from `cwd` (a filesystem walk) — fine for
	 * tests, but the per-tool-call permission path passes it to avoid the walk
	 * (distribution review 2026-09-09, L2 / efficiency pass).
	 */
	oneCodeProjectSettings?: string;
}

const REASON = (token: string) =>
	`it writes ${token}, which holds the permission rules and auto-mode configuration that contain this agent`;

/**
 * Reason text when this call writes a safety-control file, undefined otherwise.
 * Paths are resolved through symlinks (dangling leaves and not-yet-existing
 * files included), so linking a settings file elsewhere and writing the link
 * does not slip past.
 */
export function safetyControlWrite({ toolName, input, cwd, home, oneCodeProjectSettings }: FloorInput): string | undefined {
	const perRepoSettings = oneCodeProjectSettings ?? oneCodeProjectSettingsPath(cwd, home);

	if (isWritingTool(toolName)) {
		const raw = input.path ?? input.file_path ?? input.notebook_path;
		if (typeof raw !== "string" || raw.length === 0) return undefined;
		const resolved = resolveForContainment(toAbsolute(cwd, raw, home));
		return resolved && isSafetyControlTarget(resolved, home, perRepoSettings) ? REASON(raw) : undefined;
	}

	// `monitor` runs a shell command exactly as `bash` does (review L1).
	if (toolName === "bash" || toolName === "monitor") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;
		const evidence = analyzeShellCommand({ command, cwd, home });
		const forms = controlFileForms(home, perRepoSettings);
		for (const write of evidence.writes) {
			if (write.resolved && namesControlFile(write.resolved, forms, true)) return REASON(write.token);
		}
		// A command the pre-gate cannot prove read-only may write in ways its
		// evidence does not model (an output operand, an option's value, a
		// nested script), and until 2026-09-23 such a write reached neither this
		// floor nor, when the pre-gate wrongly said "safe", the classifier
		// (SECURITY-REVIEW-2026-09-23 H3). So for those the floor is textual, as
		// the PowerShell one below: any word naming a gate-control file stops the
		// call. A proven read (`cat .claude/settings.json`) is not stopped.
		// `readOnlyOutside` means every command was proven read-only by its
		// options and only the location escalated: a read, not a hidden write.
		if (evidence.verdict === "escalate" && !evidence.readOnlyOutside) {
			const named = shellNamesControlFile(command, cwd, home, perRepoSettings, 0, forms);
			if (named) return REASON(named);
		}
	}

	if (toolName === "powershell") {
		// No PowerShell write model yet, so the floor is textual and wider than
		// bash's: ANY mention of a gate-control file in the command line stops it,
		// whether the cmdlet reads or writes. A `Get-Content` of settings.json
		// costs one prompt; a `Set-Content` that slipped through would cost the
		// gate (the floor may only ever say "stop" — header).
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;
		// PowerShell wildcards (`*`, `?`, `[…]`) have no leading-dot rule.
		const forms = controlFileForms(home, perRepoSettings);
		for (const token of powershellPathTokens(command, home)) {
			const absolute = toAbsolute(cwd, token, home);
			if (namesControlFile(resolveForContainment(absolute) ?? absolute, forms, false)) return REASON(token);
		}
	}

	return undefined;
}

/**
 * Path-looking tokens of a PowerShell line, quotes stripped, `$env:USERPROFILE`,
 * `$env:HOME`, `$HOME` and `~` expanded to the home dir, backslashes
 * forward-slashed. Anything with a separator or a `.json`-style file name
 * counts; the floor tolerates false positives.
 */
export function powershellPathTokens(command: string, home: string): string[] {
	const out: string[] = [];
	for (const raw of command.split(/[\s;|()]+/)) {
		let token = raw.replace(/^["']+|["',]+$/g, "");
		if (!token) continue;
		token = token
			.replace(/^\$env:(USERPROFILE|HOME)/i, home)
			.replace(/^\$HOME\b/i, home)
			.replace(/^~(?=[\\/]|$)/, home)
			.replace(/\\/g, "/");
		// Parameter names (`-Path`) are not paths; `-Path:value` carries one.
		if (token.startsWith("-")) {
			const colon = token.indexOf(":");
			if (colon === -1) continue;
			token = token.slice(colon + 1);
		}
		if (/[\\/]/.test(token) || /\.json$/i.test(token)) out.push(token);
	}
	return out;
}

/**
 * The gate-control file spellings the textual floor matches in a command line,
 * lowercased, with `\\` turned to `/` and `/./`, `//` collapsed.
 */
const CONTROL_FILE_TEXT =
	/(^|[\s'"=/<>|;&(:])(\.claude\/settings(\.local)?\.json|\.onecode\/(projects\/[^\s'"/]+\/)?settings\.json|managed-settings\.json|\.claude\.json)(?=$|[\s'";|&)<>])/;

/**
 * The first word of a shell line that names a gate-control file, or
 * undefined. Every word counts, read or write, plus the value after an `=`
 * (`--output=…`, `of=…`) and the words of a nested `sh -c '…'` script; `cd`
 * is followed, per subshell scope, so a relative name is resolved where the
 * shell would. Where the directory cannot be known (the line does not parse,
 * a `cd` sits in a loop body that runs more than once, or its target is an
 * expansion), a word whose file name is a control file's stops by name alone.
 * False positives cost one stop; the floor may only ever say "stop".
 */
export function shellNamesControlFile(
	command: string,
	cwd: string,
	home: string,
	oneCodeProjectSettings?: string,
	depth = 0,
	/** Resolved once per top-level call, not once per word. */
	forms: ReadonlySet<string> = controlFileForms(home, oneCodeProjectSettings),
): string | undefined {
	const text = command.toLowerCase().replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
	const match = CONTROL_FILE_TEXT.exec(text);
	if (match) return match[2];

	const { segments, parseFailed } = parseCommand(command);
	const dirs = scopedTracker(cwd);
	const moves = (segment: (typeof segments)[number]) => ["cd", "pushd", "popd"].includes(resolvePayload(segment.tokens).command);
	// Decided before the walk: in a loop, a word read before the `cd` runs after it on the next pass.
	const unknownDir =
		parseFailed ||
		segments.some((segment) => {
			if (!moves(segment)) return false;
			const payload = resolvePayload(segment.tokens);
			const target = payload.args.find((token) => !token.value.startsWith("-"));
			// `cd -` goes to $OLDPWD.
			const previous = payload.args.some((token) => token.value === "-");
			return (
				payload.command !== "cd" ||
				previous ||
				segment.enclosing.some((construct) => LOOPS.has(construct)) ||
				!!target?.dynamic ||
				!!target?.glob ||
				(!!target && isUnknownTilde(target.value))
			);
		});
	// Lowercased on every platform: a false positive costs one stop.
	const baseName = (path: string) => path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1).toLowerCase();
	const controlNames = new Set([...forms].map(baseName));
	for (const segment of segments) {
		const dir = dirs.get(segment);
		const payload = resolvePayload(segment.tokens);
		for (const word of [...segment.tokens.map((token) => token.value), ...segment.redirects, ...segment.inputs.map((token) => token.value)]) {
			if (depth < 3 && /\s/.test(word)) {
				const nested = shellNamesControlFile(word, dir, home, oneCodeProjectSettings, depth + 1, forms);
				if (nested) return nested;
			}
			const eq = word.indexOf("=");
			for (const candidate of eq >= 0 ? [word, word.slice(eq + 1)] : [word]) {
				if (!candidate || isUnknownTilde(candidate)) continue;
				const resolved = resolveForContainment(toAbsoluteBash(dir, candidate, home));
				if (resolved && namesControlFile(resolved, forms, true)) return candidate;
				if (unknownDir && controlNames.has(baseName(candidate))) return candidate;
			}
		}
		if (payload.command === "cd" && !unknownDir) {
			const target = payload.args.find((token) => !token.value.startsWith("-"));
			if (target) dirs.set(segment, toAbsoluteBash(dir, target.value, home));
		}
	}
	return undefined;
}
