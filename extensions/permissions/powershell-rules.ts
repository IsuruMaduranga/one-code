/**
 * Claude Code's `PowerShell(...)` permission-rule semantics (pure).
 *
 * The rule shape is Bash's — `PowerShell(git status:*)`, wildcards, a bare
 * `PowerShell` — but the command line is PowerShell's, so three things differ
 * (findings §22, the reconstructed `PowerShellTool/powershellPermissions.ts`):
 *
 * - **Alias canonicalization.** `ls`, `dir`, `gci` are all `Get-ChildItem`;
 *   `rm`, `del`, `ri` are all `Remove-Item`. A rule and a command are compared
 *   after the leading command word is resolved through Claude Code's alias
 *   table (`COMMON_ALIASES`, copied) and lowercased — cmdlet names are
 *   case-insensitive. Aliases PowerShell 7 dropped because they collide with
 *   native executables (`sort`, `sc`, `curl`, `wget`) are deliberately absent,
 *   as in CC: mapping `sort` to `Sort-Object` would judge the wrong program.
 * - **Statement split.** A command line is split on `|`, `;`, `&&`, `||` and
 *   unquoted newlines, outside `'…'`, `"…"` and `@'…'@` / `@"…"@` here-strings,
 *   with backtick escapes honoured. For an allow rule every part must match
 *   (CC: "every subcommand must match"); a deny/ask rule fires on any part.
 *   Unbalanced quoting is a parse failure → no allow, the user is asked.
 * - **No AST.** Claude Code parses the command; v1 here is textual and
 *   conservative in the only direction that matters: a wildcard or prefix
 *   allow never covers a line whose meaning is not on its face — `$(…)`
 *   subexpressions, backtick escapes, the `&`/`.` call operators,
 *   `Invoke-Expression`, `-EncodedCommand`, script blocks.
 *
 * `powershellReadOnly` ports the read-only allowlist Claude Code uses to skip
 * approval — the cmdlet sets from the 2.1.276 binary — and adds path
 * containment by shape: a read of an absolute, `~`, drive-lettered, UNC or
 * `..` path is not auto-cleared (UNC paths always ask in CC). Anything the
 * check cannot vouch for is simply "not read-only", which costs a classifier
 * call or a prompt, never a bypass — working-docs/decisions/windows.md.
 */

import { isSensitivePath } from "../auto-mode/sensitive.ts";
import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { isWithin, resolveForContainment, toAbsolute } from "../auto-mode/paths.ts";

/** Claude Code's `COMMON_ALIASES` (utils/powershell/parser.ts), alias → canonical cmdlet. */
export const POWERSHELL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	ls: "Get-ChildItem",
	dir: "Get-ChildItem",
	gci: "Get-ChildItem",
	cat: "Get-Content",
	type: "Get-Content",
	gc: "Get-Content",
	cd: "Set-Location",
	sl: "Set-Location",
	chdir: "Set-Location",
	pushd: "Push-Location",
	popd: "Pop-Location",
	pwd: "Get-Location",
	gl: "Get-Location",
	gi: "Get-Item",
	gp: "Get-ItemProperty",
	ni: "New-Item",
	mkdir: "New-Item",
	md: "New-Item",
	ri: "Remove-Item",
	del: "Remove-Item",
	rd: "Remove-Item",
	rmdir: "Remove-Item",
	rm: "Remove-Item",
	erase: "Remove-Item",
	mi: "Move-Item",
	mv: "Move-Item",
	move: "Move-Item",
	ci: "Copy-Item",
	cp: "Copy-Item",
	copy: "Copy-Item",
	cpi: "Copy-Item",
	si: "Set-Item",
	rni: "Rename-Item",
	ren: "Rename-Item",
	ps: "Get-Process",
	gps: "Get-Process",
	kill: "Stop-Process",
	spps: "Stop-Process",
	start: "Start-Process",
	saps: "Start-Process",
	sajb: "Start-Job",
	ipmo: "Import-Module",
	echo: "Write-Output",
	write: "Write-Output",
	sleep: "Start-Sleep",
	help: "Get-Help",
	man: "Get-Help",
	gcm: "Get-Command",
	gsv: "Get-Service",
	gv: "Get-Variable",
	sv: "Set-Variable",
	h: "Get-History",
	history: "Get-History",
	iex: "Invoke-Expression",
	iwr: "Invoke-WebRequest",
	irm: "Invoke-RestMethod",
	icm: "Invoke-Command",
	ii: "Invoke-Item",
	nsn: "New-PSSession",
	etsn: "Enter-PSSession",
	exsn: "Exit-PSSession",
	gsn: "Get-PSSession",
	rsn: "Remove-PSSession",
	cls: "Clear-Host",
	clear: "Clear-Host",
	select: "Select-Object",
	where: "Where-Object",
	foreach: "ForEach-Object",
	"%": "ForEach-Object",
	"?": "Where-Object",
	measure: "Measure-Object",
	ft: "Format-Table",
	fl: "Format-List",
	fw: "Format-Wide",
	oh: "Out-Host",
	ogv: "Out-GridView",
	ac: "Add-Content",
	clc: "Clear-Content",
	tee: "Tee-Object",
	epcsv: "Export-Csv",
	sp: "Set-ItemProperty",
	rp: "Remove-ItemProperty",
	cli: "Clear-Item",
	epal: "Export-Alias",
	sls: "Select-String",
});

const aliasLookup = new Map(Object.entries(POWERSHELL_ALIASES).map(([alias, canonical]) => [alias.toLowerCase(), canonical]));

/** Windows PATHEXT suffixes PowerShell resolves for a path-free command name. */
const PATHEXT = /\.(exe|cmd|bat|com)$/i;

/**
 * The canonical spelling of a command word: alias → cmdlet, a path-free
 * `git.exe` → `git` (so git rules match either spelling). Case is preserved
 * for display; comparisons lowercase both sides.
 */
export function canonicalCommandName(word: string): string {
	const trimmed = word.trim();
	if (!trimmed) return trimmed;
	const alias = aliasLookup.get(trimmed.toLowerCase());
	if (alias) return alias;
	if (!/[\\/]/.test(trimmed) && PATHEXT.test(trimmed)) {
		const stripped = trimmed.replace(PATHEXT, "");
		// `where.exe` is the native search tool; bare `where` is the Where-Object
		// alias. The extension is what tells them apart, so it stays.
		return aliasLookup.has(stripped.toLowerCase()) ? trimmed : stripped;
	}
	return trimmed;
}

/** Canonicalize the command word of one statement; the rest of the statement is untouched. */
export function canonicalizeStatement(statement: string): string {
	const trimmed = statement.trim();
	const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
	if (!match) return trimmed;
	return `${canonicalCommandName(match[1])}${match[2]}`;
}

// ---------------------------------------------------------------------------
// Statement split

/**
 * The separately executing statements of a PowerShell line — what `|`, `;`,
 * `&&`, `||` and unquoted newlines separate — or undefined when quoting is
 * unbalanced. Single quotes, double quotes, here-strings (`@'…'@`, `@"…"@`,
 * whose closer must start a line) and backtick escapes are honoured; a `|`
 * inside `Where-Object { $_ -match 'a|b' }` still splits, conservatively, so
 * an allow rule over a script block has to cover the pieces.
 */
export function powershellStatements(command: string): string[] | undefined {
	// One decision parses the same line from several places (read-only check,
	// allow-rule split, match forms, guards, git-status detection); a one-entry
	// memo keyed by the exact string keeps that to one scan per command.
	if (lastSplit?.command === command) return lastSplit.statements?.slice();
	const statements = splitStatements(command);
	lastSplit = { command, statements };
	return statements?.slice();
}
let lastSplit: { command: string; statements: string[] | undefined } | undefined;

function splitStatements(command: string): string[] | undefined {
	const parts: string[] = [];
	let current = "";
	let i = 0;
	const text = command;
	type Quote = "'" | '"' | "@'" | '@"' | undefined;
	let quote: Quote;
	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push(trimmed);
		current = "";
	};
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (quote === "@'" || quote === '@"') {
			// A here-string closes only with its terminator at the start of a line.
			const closer = quote === "@'" ? "'@" : '"@';
			if ((i === 0 || text[i - 1] === "\n") && text.startsWith(closer, i)) {
				current += closer;
				i += 2;
				quote = undefined;
				continue;
			}
			current += ch;
			i++;
			continue;
		}
		if (quote === "'") {
			current += ch;
			i++;
			if (ch === "'") {
				if (next === "'") {
					current += next;
					i++; // doubled quote is a literal quote
				} else quote = undefined;
			}
			continue;
		}
		if (quote === '"') {
			current += ch;
			i++;
			if (ch === "`" && i < text.length) {
				current += text[i];
				i++;
				continue;
			}
			if (ch === '"') {
				if (next === '"') {
					current += next;
					i++;
				} else quote = undefined;
			}
			continue;
		}
		// Unquoted.
		if (ch === "`" && i + 1 < text.length) {
			current += ch + text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "#" && startsComment(text, i)) {
			// Line comment runs to end of line.
			const eol = text.indexOf("\n", i);
			i = eol === -1 ? text.length : eol;
			continue;
		}
		if (ch === "@" && (next === "'" || next === '"')) {
			quote = next === "'" ? "@'" : '@"';
			current += ch + next;
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			i++;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			push();
			i += 2;
			continue;
		}
		if (ch === "|" || ch === ";" || ch === "\n") {
			push();
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (quote !== undefined) return undefined;
	push();
	return parts;
}

/**
 * Whether the `#` at `i` starts a comment: only at the start of a token. In
 * `x#(Set-Content f y)` it is part of the word, and the parenthesis after it
 * still runs.
 */
function startsComment(text: string, i: number): boolean {
	return i === 0 || /[\s;|&(){}]/.test(text[i - 1]);
}

/**
 * Whether the line has a `(` outside quotes. PowerShell evaluates a grouping
 * expression in argument position before calling the command, so
 * `Write-Output (Set-Content f x)` writes `f` behind a read-only cmdlet
 * (AUTO-MODE-SECURITY-REVIEW-2026-09-24 H2); Claude Code's parser marks the
 * same node a subexpression. A quoted `(` is a literal (`"Program Files (x86)"`),
 * and a backtick-escaped one is too.
 */
function hasGroupingExpression(command: string): boolean {
	let quote: "'" | '"' | "@'" | '@"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "@'" || quote === '@"') {
			if ((i === 0 || command[i - 1] === "\n") && command.startsWith(quote === "@'" ? "'@" : '"@', i)) {
				quote = undefined;
				i++;
			}
			continue;
		}
		if (quote === "'" || quote === '"') {
			if (quote === '"' && ch === "`") i++;
			else if (ch === quote) {
				if (command[i + 1] === quote) i++;
				else quote = undefined;
			}
			continue;
		}
		if (ch === "`") i++;
		else if (ch === "#" && startsComment(command, i)) {
			const eol = command.indexOf("\n", i);
			i = eol === -1 ? command.length : eol;
		} else if (ch === "@" && (command[i + 1] === "'" || command[i + 1] === '"')) {
			quote = command[i + 1] === "'" ? "@'" : '@"';
			i++;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "(") return true;
	}
	return false;
}

/** `& cmd` (call operator) or `. script.ps1` (dot-sourcing) at the head of a statement. */
function startsWithCallOperator(statement: string): boolean {
	const trimmed = statement.trim();
	return trimmed.startsWith("&") || /^\.\s/.test(trimmed);
}

/** The first whitespace-delimited word of a statement, canonicalized and lowercased. */
export function statementCommand(statement: string): string {
	const word = statement.trim().split(/\s+/)[0] ?? "";
	return canonicalCommandName(word).toLowerCase();
}

/**
 * Why a wildcard or prefix allow rule must not cover this line: constructs
 * whose effect is not what the words say. Exact rules (the literal string the
 * user approved) are unaffected. Returns undefined when none is present.
 */
export function powershellInjectionSyntax(command: string): string | undefined {
	if (/\$\(/.test(command)) return "a $(…) subexpression";
	if (/`/.test(command)) return "a backtick escape";
	if (/\{/.test(command)) return "a script block";
	if (hasGroupingExpression(command)) return "a (…) grouping expression";
	if (/-e(nc|ncoded|ncodedcommand)?\b/i.test(command) && /\b(pwsh|powershell)(\.exe)?\b/i.test(command)) return "an encoded command";
	const statements = powershellStatements(command);
	for (const statement of statements ?? []) {
		if (startsWithCallOperator(statement)) return "the call (&) or dot-source operator";
		const cmd = statementCommand(statement);
		if (cmd === "invoke-expression" || cmd === "invoke-command" || cmd === "start-process" || cmd === "start-job") return `\`${cmd}\``;
		if (cmd === "pwsh" || cmd === "powershell" || cmd === "cmd" || cmd === "wsl" || cmd === "bash" || cmd === "sh") return `a nested \`${cmd}\` shell`;
	}
	return undefined;
}

/** The `-Command`/`-c` script of a nested `pwsh …` / `powershell …` statement, if any. */
function nestedShellScript(statement: string): string | undefined {
	const cmd = statementCommand(statement);
	if (cmd !== "pwsh" && cmd !== "powershell") return undefined;
	const match = /\s-(?:c|command)\s+(.*)$/is.exec(statement);
	if (!match) return undefined;
	const raw = match[1].trim();
	const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
	return quoted ? quoted[2] : raw;
}

/**
 * Every spelling a deny/ask pattern is tested against: the whole line, each
 * statement raw, each statement with its command word canonicalized, and a
 * nested `pwsh -Command '…'` script expanded recursively — so `PowerShell(Remove-Item:*)`
 * as a deny catches `ls; rm -r x`, `del x`, and `pwsh -c "rm x"` alike. The
 * bash counterpart is `bashMatchForms`; as there, widening here can only make
 * the gate stricter.
 */
export function powershellMatchForms(command: string, depth = 0): string[] {
	const forms = new Set<string>();
	const trimmed = command.trim();
	if (!trimmed) return [];
	forms.add(trimmed);
	forms.add(canonicalizeStatement(trimmed));
	if (depth > 4) return [...forms];
	for (const statement of powershellStatements(trimmed) ?? []) {
		forms.add(statement);
		forms.add(canonicalizeStatement(statement));
		const nested = nestedShellScript(statement);
		if (nested) for (const form of powershellMatchForms(nested, depth + 1)) forms.add(form);
	}
	return [...forms];
}

// ---------------------------------------------------------------------------
// Read-only allowlist

/**
 * The read-only cmdlet sets in the 2.1.276 binary (findings §22), plus the
 * neutral output pair, plus — One Code's addition (2026-09-19, user decision,
 * working-docs/decisions/windows.md) — the pure in-process pipeline cmdlets a
 * read-only line is piped through: they shape objects already in memory and
 * touch neither disk nor network. `Where-Object`/`ForEach-Object` are NOT
 * here: they take script blocks, which the check refuses anyway. Claude Code's
 * captured list has no pipeline cmdlets at all, so `Select-String … |
 * Measure-Object` (the /doctor transcript scan) always went to the classifier.
 */
export const READ_ONLY_POWERSHELL_COMMANDS = new Set<string>([
	// search
	"select-string",
	"get-childitem",
	"findstr",
	"where.exe",
	// read
	"get-content",
	"get-item",
	"test-path",
	"resolve-path",
	"get-process",
	"get-service",
	"get-location",
	"get-filehash",
	"get-acl",
	"format-hex",
	// neutral output
	"write-output",
	"write-host",
	// pure pipeline transforms (One Code's addition)
	"select-object",
	"sort-object",
	"measure-object",
	"group-object",
	"convertfrom-json",
	"out-string",
	"format-table",
	"format-list",
	"format-wide",
	"format-custom",
]);

/** Parameters that turn a read-only cmdlet into a write. */
const WRITING_PARAMETERS = /^-(outfile|filepath|destination)\b/i;

/**
 * `-ComputerName` (and its `-Cn` alias, and any abbreviation PowerShell
 * accepts for it) sends `Get-Process`/`Get-Service` to another machine.
 */
const REMOTE_PARAMETER = /^-(cn|c(o(m(p(u(t(e(r(n(a(m(e)?)?)?)?)?)?)?)?)?)?)?)(:|$)/i;

/**
 * Whether a token names a path this check will not vouch for by shape: UNC
 * (`\\server`), home (`~`), a PSDrive outside the filesystem (`HKLM:`,
 * `env:`), or one that climbs (`..`). An absolute or drive-lettered path is
 * judged by `pathProblem` when roots are known, and refused otherwise.
 */
function pathUnvouchable(value: string): boolean {
	if (!value) return false;
	if (value.startsWith("\\\\") || value.startsWith("//")) return true;
	if (/^[A-Za-z][A-Za-z0-9]+:/.test(value)) return true; // HKLM:, env:, cert: (a drive is one letter)
	// Drive-relative (`C:foo.txt`, no separator after the colon) means "foo.txt
	// relative to PowerShell's current directory ON C:", which need not be the
	// tool's cwd; `path.isAbsolute` does not call it absolute, so `toAbsolute`
	// would join it onto the cwd and vouch for the wrong file. Refuse by shape.
	if (/^[A-Za-z]:(?![\\/])/.test(value)) return true;
	if (value.startsWith("~")) return true;
	if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return true;
	return false;
}

/**
 * PowerShell's array syntax splits an argument on commas — outside quotes.
 * `"a,b.txt"` is one path with a comma in its name; `a,"b,c"` is two.
 */
export function splitPowerShellList(token: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const ch of token) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ",") {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts;
}

/** An absolute path by Windows or POSIX spelling: `C:\x`, `C:/x`, `/x`, `\x`. */
function isAbsoluteSpelling(value: string): boolean {
	return /^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\");
}

export interface PowerShellReadOnlyOptions {
	/** The working directory the command runs in. */
	cwd: string;
	/** The user's home, for `toAbsolute`. */
	home: string;
	/**
	 * REALPATH-resolved directories an absolute path may point into besides the
	 * working directory: the harness's own session dirs (memory, scratchpad,
	 * persisted results, this project's transcripts — matcher.ts `DecideInput`),
	 * resolved once per session by the caller.
	 */
	readableRoots?: string[];
}

type WildcardPart = { star: true } | { star: false; matches: (ch: string) => boolean };

/**
 * A PowerShell wildcard component (`*`, `?`, `[a-c]`) as a case-insensitive
 * matcher, or undefined. Matched without a regex over the whole name: the
 * model writes the pattern, and `*a*a*a…z` would backtrack polynomially
 * against every directory entry on the permission-gate path.
 */
function wildcardMatcher(pattern: string): ((name: string) => boolean) | undefined {
	const parts: WildcardPart[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		const close = ch === "[" ? pattern.indexOf("]", i + 1) : -1;
		if (ch === "*") {
			if (!parts.at(-1)?.star) parts.push({ star: true });
		} else if (ch === "?") parts.push({ star: false, matches: () => true });
		else if (close > i + 1) {
			let set: RegExp;
			try {
				set = new RegExp(`^[${pattern.slice(i + 1, close).replace(/[\\\]^]/g, "\\$&")}]$`, "i");
			} catch {
				return undefined;
			}
			parts.push({ star: false, matches: (c) => set.test(c) });
			i = close;
		} else {
			const lower = ch.toLowerCase();
			parts.push({ star: false, matches: (c) => c.toLowerCase() === lower });
		}
	}
	// Greedy match that backtracks only to the last `*`: O(name × pattern).
	return (name) => {
		let p = 0;
		let t = 0;
		let starAt = -1;
		let resumeAt = 0;
		while (t < name.length) {
			const part = parts[p];
			if (part && !part.star && part.matches(name[t])) {
				p++;
				t++;
			} else if (part?.star) {
				starAt = p++;
				resumeAt = t;
			} else if (starAt >= 0) {
				p = starAt + 1;
				t = ++resumeAt;
			} else return false;
		}
		while (parts[p]?.star) p++;
		return p === parts.length;
	};
}

/**
 * The paths a wildcard in the last component names, or undefined when they
 * cannot be enumerated (a wildcard in a directory component, an unreadable
 * or huge directory). Matched case-insensitively and with hidden entries, a
 * superset of what PowerShell reads, so every match that could be read is judged.
 */
function wildcardTargets(absolute: string): string[] | undefined {
	const dir = dirname(absolute);
	const matches = wildcardMatcher(basename(absolute));
	if (/[*?[]/.test(dir) || !matches) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [dir];
	}
	if (entries.length > 2_000) return undefined;
	return [dir, ...entries.filter((entry) => matches(entry)).map((entry) => join(dir, entry))];
}

/**
 * Why a path token must not be vouched for, or undefined. Each comma-separated
 * part (PowerShell's array syntax, `-Path a,b`; commas inside quotes are part
 * of the name) is judged on its own: refused by shape when unvouchable, then
 * resolved through `resolveForContainment`, relative parts included. A
 * relative name is not inside by construction: an in-project `notes.txt` can
 * be a symlink out of it (AUTO-MODE-SECURITY-REVIEW-2026-09-24 M4). A
 * wildcard leaf is judged match by match. Every target must lie inside a root
 * and resolve to no credential path. With no roots (no options) an absolute
 * part is refused and a relative one passes, the pre-2026-09-19 behaviour.
 */
function pathProblem(value: string, opts: PowerShellReadOnlyOptions | undefined, roots: string[]): string | undefined {
	const outside = "a path outside the working directory";
	for (const part of splitPowerShellList(value)) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		if (pathUnvouchable(trimmed)) return outside;
		const absoluteSpelling = isAbsoluteSpelling(trimmed);
		if (!opts) {
			if (absoluteSpelling) return outside;
			continue;
		}
		// Resolve only what THIS platform's path module calls absolute: on a POSIX
		// host `C:\x` is not, and `toAbsolute` would join it onto the cwd and
		// vouch for a file the shell would never touch. Refuse it by shape there.
		if (absoluteSpelling && !isAbsolute(trimmed)) return outside;
		// PowerShell on macOS and Linux takes `\` as a separator too, so `sub\link`
		// is `sub/link` there, not one file named with a backslash.
		const spelled = sep === "/" ? trimmed.replaceAll("\\", "/") : trimmed;
		const absolute = toAbsolute(opts.cwd, spelled, opts.home);
		const targets = /[*?[]/.test(spelled) ? wildcardTargets(absolute) : [absolute];
		if (targets === undefined) return outside;
		for (const target of targets) {
			const resolved = resolveForContainment(target);
			if (resolved === undefined || !roots.some((root) => isWithin(root, resolved))) return outside;
			if (isSensitivePath(resolved)) return "a credential or secret path";
		}
	}
	return undefined;
}

export interface PowerShellReadOnlyVerdict {
	readOnly: boolean;
	/** Why not, for the decision log — never echoes expanded values. */
	reason?: string;
}

/**
 * Whether every statement of the line is a read-only cmdlet (or `where.exe`)
 * with arguments the check can see through: no redirection, no variables or
 * subexpressions, no script blocks, no writing parameters, no path outside
 * the working directory by shape. Positive proof only; anything else is not
 * read-only and takes the ordinary route (classifier in auto mode, a prompt
 * elsewhere).
 */
export function powershellReadOnly(command: string, opts?: PowerShellReadOnlyOptions): PowerShellReadOnlyVerdict {
	const statements = powershellStatements(command);
	if (statements === undefined) return { readOnly: false, reason: "unbalanced quoting" };
	if (statements.length === 0) return { readOnly: false, reason: "empty command" };
	if (/[<>]/.test(command)) return { readOnly: false, reason: "redirection" };
	if (/\$/.test(command)) return { readOnly: false, reason: "a variable or subexpression" };
	if (/[`{}]/.test(command)) return { readOnly: false, reason: "an escape or script block" };
	if (hasGroupingExpression(command)) return { readOnly: false, reason: "a (…) grouping expression, which runs its own command" };
	// The cwd's realpath once per command (the roots arrive resolved), not once per token.
	const roots = opts ? [resolveForContainment(opts.cwd) ?? opts.cwd, ...(opts.readableRoots ?? [])] : [];
	for (const statement of statements) {
		if (startsWithCallOperator(statement)) return { readOnly: false, reason: "the call operator" };
		const cmd = statementCommand(statement);
		if (!READ_ONLY_POWERSHELL_COMMANDS.has(cmd)) return { readOnly: false, reason: `\`${cmd}\` is not a read-only cmdlet` };
		const tokens = statement.trim().split(/\s+/).slice(1);
		for (const token of tokens) {
			if (WRITING_PARAMETERS.test(token)) return { readOnly: false, reason: `${token.split(":")[0]} writes or forwards` };
			if (REMOTE_PARAMETER.test(token)) return { readOnly: false, reason: `${token.split(":")[0]} reaches another machine` };
			// `-Path:value` binds its value in the same word; until 2026-09-23 the
			// whole word was skipped as a parameter name, so `Get-Content
			// -Path:~/.ssh/id_rsa` and a UNC `-LiteralPath:\\host\share` passed
			// (SECURITY-REVIEW-2026-09-23 H5). The bound value is a path like any other.
			const colon = token.startsWith("-") ? token.indexOf(":") : -1;
			const value = token.startsWith("-") ? (colon > 0 ? token.slice(colon + 1) : "") : token;
			if (!value) continue;
			const unquoted = value.replace(/^["']|["']$/g, "");
			if (splitPowerShellList(unquoted).some((part) => isSensitivePath(part.trim()))) {
				return { readOnly: false, reason: "a credential or secret path" };
			}
			// By shape (UNC, ~, PSDrive, ..) a token is never vouched for. An absolute
			// path is read-only only when it resolves inside the working directory or
			// a harness session dir (2026-09-19: /doctor's transcript scan on Windows
			// spelled `<agentDir>\sessions\…` and was classified —
			// working-docs/decisions/auto-mode.md); a comma list is judged part by part.
			const problem = pathProblem(value, opts, roots);
			if (problem) return { readOnly: false, reason: problem };
		}
	}
	return { readOnly: true };
}


