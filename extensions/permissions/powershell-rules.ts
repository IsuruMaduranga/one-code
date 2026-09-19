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
 * call or a prompt, never a bypass — docs/decisions/windows.md.
 */

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
		if (ch === "#") {
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
 * docs/decisions/windows.md) — the pure in-process pipeline cmdlets a
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
 * Whether a token names a path this check will not vouch for by shape: UNC
 * (`\\server`), home (`~`), a PSDrive outside the filesystem (`HKLM:`,
 * `env:`), or one that climbs (`..`). An absolute or drive-lettered path is
 * judged by `pathOutsideRoots` when roots are known, and refused otherwise.
 */
function pathUnvouchable(value: string): boolean {
	if (!value) return false;
	if (value.startsWith("\\\\") || value.startsWith("//")) return true;
	if (/^[A-Za-z][A-Za-z0-9]+:/.test(value)) return true; // HKLM:, env:, cert: (a drive is one letter)
	if (value.startsWith("~")) return true;
	if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return true;
	return false;
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
	 * Resolved directories an absolute path may point into besides the working
	 * directory: the harness's own session dirs (memory, scratchpad, persisted
	 * results, this project's transcripts — matcher.ts `DecideInput`).
	 */
	readableRoots?: string[];
}

/**
 * Whether a path token lies outside every root. Each comma-separated part
 * (PowerShell's array syntax, `-Path a,b`) is judged on its own; an absolute
 * part is resolved through `resolveForContainment` — the nearest existing
 * ancestor's realpath, so a glob leaf (`C:\src\play\*.ts`) is judged by its
 * directory and a symlink planted inside the project that points out of it is
 * outside. A relative part stays inside by construction (no `..`).
 */
function pathOutsideRoots(value: string, opts: PowerShellReadOnlyOptions): boolean {
	const roots = [opts.cwd, ...(opts.readableRoots ?? [])].map((root) => resolveForContainment(root) ?? root);
	for (const part of value.split(",")) {
		const trimmed = part.trim().replace(/^["']|["']$/g, "");
		if (!trimmed) continue;
		if (pathUnvouchable(trimmed)) return true;
		if (!isAbsoluteSpelling(trimmed)) continue;
		const resolved = resolveForContainment(toAbsolute(opts.cwd, trimmed, opts.home));
		if (resolved === undefined || !roots.some((root) => isWithin(root, resolved))) return true;
	}
	return false;
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
	for (const statement of statements) {
		if (startsWithCallOperator(statement)) return { readOnly: false, reason: "the call operator" };
		const cmd = statementCommand(statement);
		if (!READ_ONLY_POWERSHELL_COMMANDS.has(cmd)) return { readOnly: false, reason: `\`${cmd}\` is not a read-only cmdlet` };
		const tokens = statement.trim().split(/\s+/).slice(1);
		for (const token of tokens) {
			if (WRITING_PARAMETERS.test(token)) return { readOnly: false, reason: `${token.split(":")[0]} writes or forwards` };
			if (token.startsWith("-")) continue;
			const value = token.replace(/^["']|["']$/g, "");
			// By shape (UNC, ~, PSDrive, ..) the token is never vouched for. An
			// absolute path is read-only only when it resolves inside the working
			// directory or a harness session dir (2026-09-19: /doctor's transcript
			// scan on Windows spelled `<agentDir>\sessions\…` and was classified —
			// docs/decisions/auto-mode.md); without roots it is refused as before.
			// A comma list is judged part by part (`-Path a,C:\x`).
			if (opts) {
				if (pathOutsideRoots(value, opts)) return { readOnly: false, reason: "a path outside the working directory" };
			} else if (pathUnvouchable(value) || isAbsoluteSpelling(value)) {
				return { readOnly: false, reason: "a path outside the working directory" };
			}
		}
	}
	return { readOnly: true };
}

/** git global flags that take a value and can precede the subcommand (`git -C x status`). */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/**
 * Whether the statement is a bare `git status` (global flags before it and
 * plain flags after it allowed, no other statements) — the call after which
 * Claude Code's classifier transcript carries a
 * `{"meta":{"gitStatus":{"clean":…}}}` ground-truth line (findings §22).
 * Works for bash and PowerShell spellings alike. Global value-taking flags
 * (`-C <dir>`, `-c <key=val>`, …) are skipped so `git -C <dir> status` is
 * still recognised instead of mistaking the flag's value for the subcommand.
 */
export function isGitStatusCommand(command: string): boolean {
	const statements = powershellStatements(command);
	if (!statements || statements.length !== 1) return false;
	if (statementCommand(statements[0]) !== "git") return false;
	const words = statements[0].trim().split(/\s+/).slice(1);
	let i = 0;
	while (i < words.length && words[i].startsWith("-")) {
		i += GIT_GLOBAL_VALUE_FLAGS.has(words[i]) ? 2 : 1;
	}
	return words[i] === "status" && words.slice(i + 1).every((w) => w.startsWith("-"));
}
