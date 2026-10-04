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
 * The consent stores (`lib/consent-stores.ts`) are gate controls too: an
 * entry in one approves a repository's hooks, MCP servers, allow rules or
 * language servers for every later session.
 *
 * The target list is deliberately exact files, not directories: ~/.claude also
 * holds memory and skills that the agent writes routinely, and a floor that
 * fires on routine work teaches the user to approve without reading.
 */

import { analyzeShellCommand, globComponentRegex, hasReadOnlyShellWords, isUnknownTilde, LOOPS, movesDirectory, parseCommand, resolvePayload, scopedTracker } from "./shell-analysis.ts";
import { claudeUserSettingsPath, managedSettingsPaths } from "../lib/claude-settings.ts";
import { CONSENT_STORE_TAIL, consentStorePaths } from "../lib/consent-stores.ts";
import { oneCodeProjectSettingsPath, oneCodeSettingsPath } from "../lib/one-code-settings.ts";
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
		// global ~/.onecode/settings.json here honours ONECODE_STATE_DIR). Spelled
		// out, not the mode-aware autoModeSettingsPaths: independent mode reads no
		// Claude Code file, but one written there would take effect the moment
		// the user switches back, so the floor guards it in both modes.
		claudeUserSettingsPath(home),
		oneCodeSettingsPath(home),
		...managedSettingsPaths(),
		// Claude Code's global state file also carries permission configuration;
		// claudeJsonPath honours CLAUDE_CONFIG_DIR so a relocated file is still caught.
		claudeJsonPath(home),
		// The per-repo One Code settings file also carries permission rules. The
		// tail regex catches it under a literal `.onecode`; this catches it when
		// ONECODE_STATE_DIR relocated the state root (review L2).
		...(oneCodeProjectSettings ? [oneCodeProjectSettings] : []),
		// The consent stores: an entry approves a repository's hooks, MCP
		// servers, allow rules or language servers for every later session.
		...consentStorePaths(home),
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
	return SETTINGS_TAIL.test(target) || ONECODE_SETTINGS_TAIL.test(target) || CONSENT_STORE_TAIL.test(target) || forms.has(target);
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

/** find's tests whose operand is a name or path pattern. */
const FIND_PATTERN_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname"]);

/**
 * Indexes of find's pattern operands under a negation (`-not -path './.git/*'`,
 * `! -name x`, `-not ( -path a -o -path b )`): patterns that exclude files
 * rather than select them.
 */
function negatedFindPatterns(words: readonly string[]): Set<number> {
	const negated = new Set<number>();
	/** Group depths opened right after a negation. */
	const negatedGroups: number[] = [];
	let depth = 0;
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		const notBefore = index > 0 && (words[index - 1] === "!" || words[index - 1] === "-not");
		if (word === "(") {
			depth++;
			if (notBefore) negatedGroups.push(depth);
		} else if (word === ")") {
			if (negatedGroups[negatedGroups.length - 1] === depth) negatedGroups.pop();
			depth--;
		} else if (FIND_PATTERN_TESTS.has(word) && index + 1 < words.length && (notBefore || negatedGroups.length > 0)) {
			negated.add(index + 1);
		}
	}
	return negated;
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
		// the PowerShell one below: any unproven word naming a gate-control file
		// stops the call. Proven read-only simple commands are excluded even in
		// an escalated compound line; their redirects and nested code are not.
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
 * `$_` (or `${_}`, `${#_}`, …) anywhere in the line: bash's last argument of
 * the previous command, which carries a proven read-only command's words into
 * a later one (`echo .claude/settings.json; rm "$_"`). Raw text, so heredoc
 * bodies and quoted spellings count too; a false positive costs one stop.
 */
const LAST_ARGUMENT = /\$(?:_|\{[#!]?_)(?![A-Za-z0-9_])/;

/**
 * The literal text every match of a find `-regex` pattern ends with (find
 * anchors the pattern to the whole path), or undefined when that is not
 * certain: no literal tail, or alternation anywhere (`|` or emacs `\|`).
 * Wildcards, groups, intervals and classes end the tail in either the emacs
 * or the POSIX spelling. Only `\` before one of `.*+?[]^$\/-` is a literal;
 * any other escape (emacs `\'` is an anchor, `\w` a class) ends the tail.
 */
export function regexLiteralTail(pattern: string): string | undefined {
	if (pattern.includes("|")) return undefined;
	const units: Array<{ literal: boolean; text: string }> = [];
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "\\" && i + 1 < pattern.length) {
			const next = pattern[++i];
			units.push({ literal: /[.*+?[\]^$\\/-]/.test(next), text: next });
		} else units.push({ literal: !/[.[\]*+?^$(){}\\]/.test(char), text: char });
	}
	// A trailing unescaped `$` only re-anchors the end find anchors anyway.
	if (units.at(-1)?.text === "$" && !units.at(-1)!.literal) units.pop();
	let tail = "";
	for (let i = units.length - 1; i >= 0 && units[i].literal; i--) tail = units[i].text + tail;
	return tail || undefined;
}

/**
 * The first word of a shell line that names a gate-control file, or
 * undefined. Every word not proven read-only counts, plus the value after an `=`
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
	const { segments, parseFailed, unknownQuoting, unattributedExpansion, pipelines } = parseCommand(command);
	const dirs = scopedTracker(cwd);
	const ignoredRanges: { start: number; end: number }[] = [];
	// Functions/eval can replace a read-only command; loop headers and case
	// subjects can change shell state outside the attributed words. Never use
	// a partial parse, such a construct, or a nested script to subtract evidence.
	const canProveWords = depth === 0 && !parseFailed && !unknownQuoting && !unattributedExpansion && !segments.some((segment) =>
		segment.enclosing.some((construct) => LOOPS.has(construct) || construct === "function_definition" || construct === "case_statement") ||
		["eval", "source", ".", "alias", "enable", "trap"].includes(resolvePayload(segment.tokens).command),
	) && !LAST_ARGUMENT.test(command);

	// Decided before the walk: in a loop, a word read before the `cd` runs after it on the next pass.
	const unknownDir =
		parseFailed ||
		segments.some((segment) => {
			const payload = resolvePayload(segment.tokens);
			// A script run in this shell (`eval "cd .claude"`, `source f`) may `cd` too.
			if (["eval", "source", "."].includes(payload.command)) return true;
			if (!movesDirectory(segment)) return false;
			const target = payload.args.find((token) => !token.value.startsWith("-"));
			// `cd -` goes to $OLDPWD.
			const previous = payload.args.some((token) => token.value === "-");
			return (
				payload.command !== "cd" ||
				previous ||
				// A pipeline's last `cd` moves the later commands of its own shell
				// under lastpipe, inside a substitution too.
				!!segment.pipelineShell ||
				// `false && cd x` may or may not move the commands after it.
				!!segment.conditional ||
				segment.enclosing.some((construct) => LOOPS.has(construct)) ||
				!!target?.dynamic ||
				!!target?.glob ||
				(!!target && isUnknownTilde(target.value))
			);
		});
	// Lowercased on every platform: a false positive costs one stop.
	const baseName = (path: string) => path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1).toLowerCase();
	const controlNames = new Set([...forms].map(baseName));
	// First pass, in order: each segment's directory and whether its words
	// alone are proven read-only. The cd tracking runs here so the second pass
	// can look ahead at a whole pipeline.
	let shellChanged = false;
	const facts = segments.map((segment) => {
		const dir = dirs.get(segment);
		const payload = resolvePayload(segment.tokens);
		// A previous assignment or stateful builtin can change command lookup
		// (PATH, a hash entry, shell options, …). Arithmetic commands and
		// expansions can assign too. A standalone command proof cannot account
		// for that state. Even inert assignments/expansions forfeit it.
		shellChanged ||= !!segment.unknownTarget || !!segment.expandsIntoInput ||
			segment.tokens.some((word) => word.dynamic || /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word.value)) ||
			["read", "readarray", "mapfile", "getopts", "printf", "export", "declare", "typeset", "local", "readonly", "unset", "set", "shopt", "hash", "let"].includes(payload.command);
		const proven = canProveWords && !shellChanged && !unknownDir &&
			segment.wordRanges?.length === segment.tokens.length && hasReadOnlyShellWords(segment, dir, home);
		if (payload.command === "cd" && !unknownDir) {
			const target = payload.args.find((token) => !token.value.startsWith("-"));
			if (target) dirs.set(segment, toAbsoluteBash(dir, target.value, home));
		}
		return { dir, payload, proven };
	});
	// Pipeline output may itself be a script (`echo '…' | sh`), so a pipeline
	// member keeps its words out of the scan only when the pipeline sits in the
	// top-level shell and every member is one proven read-only command: then
	// no member runs another's output (`find … | sort`). Substitutions and
	// `( … )` stay textual.
	const provenPipelineScopes = new Set<number>();
	for (const members of pipelines) {
		const inMember = members.map((scope) => segments.flatMap((segment, index) => (segment.scopes.length === 1 && segment.scopes[0] === scope ? [index] : [])));
		const nested = segments.some((segment) => segment.scopes.length > 1 && members.includes(segment.scopes[0]));
		if (!nested && inMember.every((indexes) => indexes.length === 1 && facts[indexes[0]].proven)) {
			for (const scope of members) provenPipelineScopes.add(scope);
		}
	}
	for (const [index, segment] of segments.entries()) {
		const { dir, payload, proven } = facts[index];
		const readOnly = proven && (segment.scopes.length === 0 || (segment.scopes.length === 1 && provenPipelineScopes.has(segment.scopes[0])));
		if (readOnly) ignoredRanges.push(...segment.wordRanges!);
		// -regex/-iregex match the whole path, which the file-name glob check
		// cannot model. An unproven find selecting by one stops unless the
		// pattern's fixed tail rules out every control file's name, and only a
		// plain conjunction can rely on that: `! -regex '.*\.orig'` or a `-o`
		// branch selects everything the pattern does not.
		if (!readOnly && payload.command === "find") {
			const uncertain = payload.args.some((token) => ["-regextype", "!", "-not", "-o", "-or", ","].includes(token.value));
			for (const [i, token] of payload.args.entries()) {
				if (token.value !== "-regex" && token.value !== "-iregex") continue;
				const pattern = payload.args[i + 1];
				if (!pattern || pattern.dynamic || uncertain) return pattern?.value ?? token.value;
				const tail = regexLiteralTail(pattern.value)?.toLowerCase();
				const name = tail?.slice(tail.lastIndexOf("/") + 1);
				if (tail === undefined || name === undefined || [...controlNames].some((control) => tail.includes("/") ? control === name : control.endsWith(name))) return pattern.value;
			}
		}
		const negated = payload.command === "find" ? negatedFindPatterns(segment.tokens.map((token) => token.value)) : new Set<number>();
		const words = [
			...(readOnly ? [] : segment.tokens.map((token, index) => ({ value: token.value, negated: negated.has(index) }))),
			...[...segment.redirects, ...segment.inputs.map((token) => token.value)].map((value) => ({ value, negated: false })),
		];
		for (const { value: word, negated: excludes } of words) {
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
				// find matches names beneath its search roots, not the shell's cwd.
				// An unproven expression may delete/execute on any such match. A
				// negated pattern only excludes files, so it never selects one.
				if (payload.command === "find" && !excludes) {
					const pattern = globComponentRegex(baseName(candidate));
					if (pattern && [...controlNames].some((name) => pattern.test(name))) return candidate;
				}
			}
		}
	}
	// Keep the raw-text fallback for syntax/words the walker cannot attribute,
	// heredoc bodies included. Only exact source ranges of proven command
	// words disappear; never use string replacement (the same text may also
	// occur in a redirect or in an unproven command).
	let unproven = "";
	let at = 0;
	for (const range of ignoredRanges.sort((a, b) => a.start - b.start)) {
		unproven += command.slice(at, range.start) + " ";
		at = range.end;
	}
	unproven += command.slice(at);
	const text = unproven.toLowerCase().replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
	return CONTROL_FILE_TEXT.exec(text)?.[2];
}
