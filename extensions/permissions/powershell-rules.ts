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
 * - **Statement split.** A command line is split on `|`, `;`, `&&`, `||`, a
 *   single (background) `&`, and unquoted line breaks (`\n`, or `\r` on its
 *   own), outside `'…'`, `"…"` and `@'…'@` / `@"…"@` here-strings (the
 *   typographic quotes included, as pwsh reads them) and comments, with
 *   backtick escapes honoured. For an allow rule every part must match (CC:
 *   "every subcommand must match"); a deny/ask rule fires on any part, and on
 *   a rough split as well. Unbalanced quoting is a parse failure → no allow,
 *   the user is asked.
 * - **Textual rule matching.** Rule matching stays on this split, which
 *   matches more forms than the tree, never fewer; it is conservative in the
 *   only direction that matters: a wildcard or prefix allow never covers a
 *   line whose meaning is not on its face — `$(…)` subexpressions, backtick
 *   escapes, the `&`/`.` call operators, `Invoke-Expression`,
 *   `-EncodedCommand`, script blocks.
 *
 * `powershellReadOnly`, the read-only verdict the gate skips approval on, is
 * judged from PowerShell's own parse instead (`powershell-tree.ts`,
 * decisions/windows.md "The PowerShell pre-gate reads PowerShell's own parse").
 */

import type { PowerShellParse } from "../lib/powershell-parser.ts";
import { type PowerShellTreeOptions, powershellTreeReadOnly } from "./powershell-tree.ts";

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
 * `&&`, `||`, a single `&` and unquoted line breaks separate — or undefined
 * when quoting is unbalanced. Single quotes, double quotes, here-strings
 * (`@'…'@`, `@"…"@`, whose closer must start a line), comments and backtick
 * escapes are honoured (`lexPowerShell`); a `|` inside `Where-Object { $_
 * -match 'a|b' }` still splits, conservatively, so an allow rule over a
 * script block has to cover the pieces.
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

/**
 * PowerShell's quote characters. The tokenizer takes the typographic quotes as
 * quotes too, interchangeably with the ASCII ones: `'x’ ; Remove-Item y ; ‘z'`
 * is three statements, not one string. Checked against pwsh 7.6's parser.
 */
const SINGLE_QUOTES = new Set(["'", "‘", "’", "‚", "‛"]);
const DOUBLE_QUOTES = new Set(['"', "“", "”", "„"]);

/**
 * How the lexer sees one character of a line: unquoted code, where separators
 * and operators mean what they say; a literal (inside a string or
 * here-string, or escaped by a backtick); or a comment, which never runs.
 */
const CODE = 0;
const LITERAL = 1;
const COMMENT = 2;
type Lex = typeof CODE | typeof LITERAL | typeof COMMENT;

/** A line break as PowerShell reads one: `\n`, and a carriage return on its own too. */
function isLineBreak(ch: string | undefined): boolean {
	return ch === "\n" || ch === "\r";
}

/**
 * Whether position `i` starts a token, where `#` and `<#` open a comment. In
 * `x#(Set-Content f y)` the `#` is part of the word, and the parenthesis after
 * it still runs.
 */
function atTokenStart(text: string, i: number): boolean {
	return i === 0 || /[\s;|&(){}]/.test(text[i - 1]);
}

/**
 * Classify every character of a PowerShell line, or undefined when a
 * string, here-string or block comment never closes. The one lexer the
 * statement split and the grouping check share, so they cannot disagree about
 * what is quoted. It follows pwsh's tokenizer on the points that decide where
 * a statement ends: both quote families, doubled quotes, backtick escapes
 * (outside quotes and inside double quotes), here-strings whose closer starts
 * a line (after `\n` or a lone `\r`), and line and block comments at a token
 * start. It does not follow a `$(…)` inside a double-quoted string; every
 * consumer refuses or rough-splits a line with `$(` anyway.
 */
function lexPowerShell(text: string): Lex[] | undefined {
	const kinds: Lex[] = new Array(text.length);
	let i = 0;
	const mark = (from: number, to: number, kind: Lex) => {
		for (let k = from; k < to; k++) kinds[k] = kind;
	};
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "`" && i + 1 < text.length) {
			kinds[i] = CODE;
			kinds[i + 1] = LITERAL;
			i += 2;
			continue;
		}
		if (ch === "#" && atTokenStart(text, i)) {
			let end = i;
			while (end < text.length && !isLineBreak(text[end])) end++;
			mark(i, end, COMMENT);
			i = end;
			continue;
		}
		if (ch === "<" && next === "#" && atTokenStart(text, i)) {
			const close = text.indexOf("#>", i + 2);
			if (close === -1) return undefined;
			mark(i, close + 2, COMMENT);
			i = close + 2;
			continue;
		}
		if (ch === "@" && next !== undefined && (SINGLE_QUOTES.has(next) || DOUBLE_QUOTES.has(next))) {
			// A here-string closes only with a quote of its family and `@` at the start of a line.
			const family = SINGLE_QUOTES.has(next) ? SINGLE_QUOTES : DOUBLE_QUOTES;
			let end = i + 2;
			while (end < text.length && !(isLineBreak(text[end - 1]) && family.has(text[end]) && text[end + 1] === "@")) end++;
			if (end >= text.length) return undefined;
			mark(i, end + 2, LITERAL);
			i = end + 2;
			continue;
		}
		if (SINGLE_QUOTES.has(ch)) {
			let end = i + 1;
			for (;;) {
				if (end >= text.length) return undefined;
				if (SINGLE_QUOTES.has(text[end])) {
					if (SINGLE_QUOTES.has(text[end + 1] ?? "")) end += 2; // a doubled quote is a literal quote
					else break;
				} else end++;
			}
			mark(i, end + 1, LITERAL);
			i = end + 1;
			continue;
		}
		if (DOUBLE_QUOTES.has(ch)) {
			let end = i + 1;
			for (;;) {
				if (end >= text.length) return undefined;
				if (text[end] === "`") end += 2;
				else if (DOUBLE_QUOTES.has(text[end])) {
					if (DOUBLE_QUOTES.has(text[end + 1] ?? "")) end += 2;
					else break;
				} else end++;
			}
			mark(i, end + 1, LITERAL);
			i = end + 1;
			continue;
		}
		kinds[i] = CODE;
		i++;
	}
	return kinds;
}

/**
 * Split on the statement separators PowerShell 7 runs: `&&`, `||`, `|`, `;`,
 * a line break (`\n`, or `\r` on its own), and a single `&`. A single `&`
 * that starts a statement is the call operator and stays in it; after `>` it
 * is part of a redirection (`2>&1`); anywhere else it is the background
 * operator, and the next statement runs at once (`Get-ChildItem & Remove-Item
 * x` runs both). Comments are dropped.
 */
function splitStatements(command: string): string[] | undefined {
	const kinds = lexPowerShell(command);
	if (!kinds) return undefined;
	const parts: string[] = [];
	let current = "";
	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push(trimmed);
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const kind = kinds[i];
		if (kind === COMMENT) continue;
		if (kind === LITERAL) {
			current += ch;
			continue;
		}
		const next = kinds[i + 1] === CODE ? command[i + 1] : undefined;
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			push();
			i++;
			continue;
		}
		if (ch === "|" || ch === ";" || isLineBreak(ch)) {
			push();
			continue;
		}
		if (ch === "&" && current.trim() !== "" && command[i - 1] !== ">") {
			push();
			continue;
		}
		current += ch;
	}
	push();
	return parts;
}

/**
 * Whether the line has a `(` outside quotes and comments. PowerShell
 * evaluates a grouping expression in argument position before calling the
 * command, so `Write-Output (Set-Content f x)` writes `f` behind a read-only
 * cmdlet (AUTO-MODE-SECURITY-REVIEW-2026-09-24 H2); Claude Code's parser
 * marks the same node a subexpression. A quoted `(` is a literal (`"Program
 * Files (x86)"`), and a backtick-escaped one is too. An unbalanced line
 * counts as having one: nothing can vouch for it.
 */
function hasGroupingExpression(command: string): boolean {
	const kinds = lexPowerShell(command);
	if (!kinds) return true;
	for (let i = 0; i < command.length; i++) if (kinds[i] === CODE && command[i] === "(") return true;
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
 * A control character the lexer does not model: C0 other than tab, line feed
 * and carriage return, DEL, C1 (NEL included), and the Unicode line and
 * paragraph separators. pwsh reads some as whitespace and some as part of a
 * word; the split here honours neither, so a line with one is never covered
 * by a wildcard or prefix allow rule.
 */
const UNRECOGNISED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Why a wildcard or prefix allow rule must not cover this line: constructs
 * whose effect is not what the words say. Exact rules (the literal string the
 * user approved) are unaffected. Returns undefined when none is present.
 */
export function powershellInjectionSyntax(command: string): string | undefined {
	if (UNRECOGNISED_CONTROL.test(command)) return "a control character";
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
	// A rough split on every separator and grouping character, quotes ignored:
	// it catches a statement inside `$(…)`, `(…)` or `{…}`, and every
	// statement of a line the lexer could not read (bash's counterpart adds
	// the same rough split for an unparseable line).
	for (const piece of trimmed.split(ROUGH_SEPARATORS)) {
		const part = piece.trim();
		if (!part) continue;
		forms.add(part);
		forms.add(canonicalizeStatement(part));
	}
	return [...forms];
}

/** Everything that can end or open a statement, for the deny/ask rough split. */
const ROUGH_SEPARATORS = /[;|&\r\n(){}]+/;

// ---------------------------------------------------------------------------
// Read-only

export interface PowerShellReadOnlyOptions extends PowerShellTreeOptions {
	/** PowerShell's own parse of the line (lib/powershell-parser.ts); without one nothing is read-only. */
	parse?: PowerShellParse;
}

export interface PowerShellReadOnlyVerdict {
	readOnly: boolean;
	/** Why not, for the decision log — never echoes expanded values. */
	reason?: string;
}

/**
 * Whether every statement of the line provably only reads inside the working
 * directory and the readable roots, judged from PowerShell's own parse
 * (`powershell-tree.ts`). Positive proof only; without a parse, or with
 * anything the tree check does not model, the line is not read-only and takes
 * the ordinary route (the classifier in auto mode, a prompt elsewhere) —
 * decisions/windows.md "The PowerShell pre-gate reads PowerShell's own parse".
 */
export function powershellReadOnly(opts: PowerShellReadOnlyOptions): PowerShellReadOnlyVerdict {
	if (!opts.parse) return { readOnly: false, reason: "PowerShell's own parse of the line is not available" };
	const verdict = powershellTreeReadOnly(opts.parse, opts);
	return verdict.ok ? { readOnly: true } : { readOnly: false, reason: verdict.reason };
}
