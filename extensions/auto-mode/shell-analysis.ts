/**
 * Deterministic shell pre-gate for auto mode (pure apart from path resolution).
 *
 * ## Why this exists and what its contract is
 *
 * Derived from the MI Copilot shell sandbox, but with an inverted contract. In
 * that codebase the analyzer was the *only* gate, so every tokenizer gap was an
 * exploitable bypass — the security review found dozens. Here it sits in front
 * of an LLM classifier which sits in front of a user prompt, so the contract is:
 *
 *   **This module may only ever conclude "provably safe". It never denies.**
 *
 * A gap therefore costs one classifier call, not a bypass. `verdict: "escalate"`
 * is the default for everything not positively recognised: unknown commands,
 * parse failures, dynamic expansion, unresolvable paths, any redirection to a
 * path that is not provably inside the working directory.
 *
 * Its second job matters as much: it extracts **deterministic evidence** —
 * resolved write targets, credential paths touched, whether a target escapes
 * the working directory, which wrapped command actually runs — and hands that
 * to the classifier. Parsing shell is exactly what an LLM classifier is worst
 * at, so giving it facts instead of a command string is the point of having
 * both layers.
 *
 * Review findings fixed relative to the original: N1 (`$'…'` ANSI-C quoting),
 * N2 (bare `.`/`..`), N3 (brace expansion), N4 (unspaced `<>&|` boundaries),
 * N5 (transparent wrappers), N6 (archive/sync tools), N7 (`find` actions),
 * N8 (in-script redirection), N10 (`>|`), N11 (git default-deny by subcommand),
 * N12 (sensitive check on every token, `cd` tracked), N13/F3/F10 (one shared
 * denylist — see `sensitive.ts`), F1 (git global flags).
 */

import { isProtectedPath } from "../permissions/protected-paths.ts";
import { isExecutionPrimitivePath, isSensitivePath } from "./sensitive.ts";
import { isWithin, resolveForContainment, toAbsoluteBash } from "./paths.ts";
import { checkoutGitRunsProgram } from "./git-checkout-programs.ts";
import { lstatSync, readdirSync } from "node:fs";
import {
	GIT_GLOBAL_SAFE,
	GIT_SUBCOMMAND_SPECS,
	PATTERN_OPTIONS,
	READ_ONLY_SPECS,
	checkFind,
	checkOptions,
	gitOperandsAllowed,
} from "./read-only-options.ts";

export type ShellVerdict = "safe" | "escalate";

export interface ShellEvidence {
	verdict: ShellVerdict;
	/** Why it escalated / what the classifier should weigh. Never contains expanded variable values. */
	notes: string[];
	/** The commands that actually run, wrappers peeled (`env rm` → `rm`). */
	commands: string[];
	/** Resolved paths this command may write, with containment already decided. */
	/**
	 * Every write target: the token as written, its absolute form as the shell
	 * reaches it (`toAbsoluteBash`: Git Bash spellings converted, `~` and cwd
	 * applied, not yet realpath'd — the form a "write it here instead" message
	 * keeps the model's spelling from), the realpath'd form, and the verdict.
	 */
	writes: { token: string; absolute: string; resolved?: string; outsideCwd: boolean }[];
	/** Credential/secret paths named anywhere in the command (original tokens, never expanded). */
	sensitivePaths: string[];
	/** In-project paths whose contents execute later (`.git/hooks/*`, `.vscode/*.json`). */
	executionPrimitives: string[];
	/**
	 * Tooling/agent-configuration paths (`permissions/protected-paths.ts`: `.cargo/`,
	 * `.claude/`, hook configs, shell rc files, …) this command writes. The
	 * `write`/`edit` tools route these to the classifier; a shell redirect or
	 * `rm`/`mv` onto the same path must not be "safe" merely for being in-project.
	 */
	protectedPaths: string[];
	/** Network-capable commands present (curl, ssh, …) — an egress signal for the classifier. */
	network: string[];
	/**
	 * Paths a read-only command reads from OUTSIDE the working directory
	 * (original tokens). Claude Code asks for every read outside it; here the
	 * read escalates so the classifier at least sees it — until 2026-09-05
	 * `cat ~/.onecode/agent/auth.json` fast-pathed as "safe"
	 * (PERMISSIONS-REVIEW-2026-09-05 H2).
	 */
	outsideReads: string[];
	/**
	 * True when the ONLY reason this escalated is one or more outside-cwd reads:
	 * no write, mutation, network, unknown command or unmodelled syntax. Plan
	 * mode uses it to put such a command to the user as a read instead of
	 * refusing it as a mutation. Never true for a "safe" verdict.
	 */
	readOnlyOutside: boolean;
	/**
	 * True when the ONLY reason this escalated is an in-project filesystem
	 * mutation/deletion — every path is inside the working directory and resolved,
	 * nothing touches the network, no credential/execution-primitive path, no
	 * unknown command, interpreter, glob, xargs, `cd`, or unmodelled syntax. The
	 * containment gate uses this to decide whether a git-recoverability check may
	 * clear the command (see auto-mode/recoverability.ts). Never true when the
	 * verdict is "safe" (nothing escalated) — it only qualifies an escalation.
	 */
	containedNonNetwork: boolean;
	/**
	 * True for a whole-working-tree destructive git op (`git reset --hard`), whose
	 * recoverability is judged against the whole tree's cleanliness rather than
	 * named paths.
	 */
	wholeTree: boolean;
}

/**
 * Commands that read and do not write, and are safe to fast-path — each only
 * with the options its table in read-only-options.ts names. `printenv` and a
 * bare `env` are not here: they dump the process environment, provider keys
 * included (Claude Code removed both from its read-only list for the same
 * reason).
 */
const READ_ONLY_COMMANDS = new Set(Object.keys(READ_ONLY_SPECS));

/**
 * Read-only commands that take no file operands, so a path-looking positional
 * (`echo a/b`, `which node`) is not a read of that path and is not checked for
 * working-directory containment.
 */
const NO_FILE_OPERANDS = new Set([
	"basename",
	"date",
	"dirname",
	"echo",
	"false",
	"hostname",
	"id",
	"printf",
	"pwd",
	"tr",
	"true",
	"uname",
	"which",
	"whoami",
	"yes",
]);

/**
 * `grep` and friends take a pattern before their paths, so the first positional
 * is not a path token. Tracked separately to avoid classifying a regex as a file.
 * `ag` and `ack` are not fast-pathed at all: both take a pager program, and ack
 * reads a project `.ackrc` this check never sees.
 */
const PATTERN_FIRST_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);

/**
 * Commands that run whatever follows them. The original only knew three of
 * these and never looked past them, so `env rm -rf ~/Desktop` classified as a
 * harmless `env` (review finding N5). Every one of these is peeled and the
 * payload command is classified instead.
 */
const TRANSPARENT_WRAPPERS = new Set([
	"command",
	"env",
	"flock",
	"ionice",
	"nice",
	"nohup",
	"script",
	"setsid",
	"stdbuf",
	"time",
	"timeout",
	"xargs",
]);

/** Options of wrapper commands that consume the following token as a value. */
const WRAPPER_VALUE_OPTIONS = new Set(["-u", "-c", "-n", "-I", "-L", "-P", "--signal", "-s", "-k"]);

/**
 * Anything here writes, deletes, or fetches-and-writes. The list is only used to
 * *escalate* — a command missing from it still escalates via the unknown-command
 * path, which is why the original's omissions (tar, rsync, zip — N6) are not
 * exploitable here. It is kept current anyway so the evidence names the risk.
 */
const MUTATION_COMMANDS = new Set([
	"7z",
	"cp",
	"dd",
	"gunzip",
	"gzip",
	"install",
	"ln",
	"mkdir",
	"mv",
	"patch",
	"rm",
	"rmdir",
	"rsync",
	"shred",
	"tar",
	"tee",
	"touch",
	"truncate",
	"unzip",
	"zip",
]);

/**
 * The delete/truncate commands whose blast radius is exactly their (in-project,
 * resolved, concrete) path arguments, so an in-project use may be cleared by the
 * containment + git-recoverability gate rather than always reaching the
 * classifier. This is an *allowlist* for the "provably contained" conclusion —
 * omission is safe (the command still escalates to the classifier via the generic
 * mutation path). Overwrite/copy tools (cp, mv, dd, tee) are deliberately left
 * out for now: their destination semantics are subtler, so they keep classifying.
 * Membership here does not clear anything on its own: every target must resolve
 * inside the working directory and the recoverability check must pass.
 */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "shred", "truncate"]);

/** Glob/other shell metacharacters we cannot enumerate, so a target carrying one is not "concrete". */
function hasGlob(token: string): boolean {
	return /[*?\[\]]/.test(token);
}

/** `git reset --hard [ref]` — a whole-working-tree discard of uncommitted changes. */
function isWholeTreeGitReset(args: Token[]): boolean {
	const positionals = args.filter((token) => !token.value.startsWith("-"));
	return positionals[0]?.value === "reset" && args.some((token) => token.value === "--hard");
}

/**
 * Whether git is being pointed at another repository or tree (`-C dir`,
 * `--git-dir[=]…`, `--work-tree[=]…`, `--namespace`, `--exec-path`). A
 * whole-tree op carrying one of these acts on THAT tree, so judging it against
 * the working directory would clear a reset of some other checkout.
 */
function hasGitRetargetFlag(args: Token[]): boolean {
	return args.some((token) => {
		const value = token.value;
		if (!value.startsWith("-")) return false;
		if (GIT_GLOBAL_VALUE_FLAGS.has(value)) return true;
		const eq = value.indexOf("=");
		return eq > 0 && GIT_GLOBAL_VALUE_FLAGS.has(value.slice(0, eq));
	});
}

/**
 * Interpreters whose *scripts* can write files the token-level pass never sees
 * (review finding N8: `awk 'BEGIN{print > "f"}'`). Their programs are not
 * parsed — they escalate unconditionally.
 */
const SCRIPT_INTERPRETERS = new Set([
	"awk",
	"bash",
	"deno",
	"gawk",
	"node",
	"perl",
	"php",
	"python",
	"python3",
	"ruby",
	"sed",
	"sh",
	"tclsh",
	"zsh",
]);

const NETWORK_COMMANDS = new Set([
	"curl",
	"dig",
	"ftp",
	"host",
	"nc",
	"netcat",
	"nmap",
	"nslookup",
	"ping",
	"rsync",
	"scp",
	"sftp",
	"ssh",
	"telnet",
	"traceroute",
	"wget",
]);

/**
 * git is **default-deny by subcommand and by option**: only the subcommands in
 * `GIT_SUBCOMMAND_SPECS` (read-only-options.ts) can be fast-pathed, each only
 * with the options its table names. The original enumerated *mutating*
 * subcommands and allowed the rest, so `git rm`, `git mv`, `git archive`,
 * `git config`, and `git update-ref` all slipped through (review finding N11);
 * until 2026-09-23 the options after an allowed subcommand were never looked
 * at, so `git branch -D`, `git diff --output=f` and `git grep -O<prog>` passed
 * as reads (SECURITY-REVIEW-2026-09-23 H1). `ls-remote` is not read-only: it
 * contacts a remote.
 */
/**
 * git global flags that take a value. `git -c k=v <sub>` can turn a read into
 * code execution (`git -c protocol.ext.allow=always clone ext::sh …` — review
 * finding F1, reproduced live there), so `-c`/`--config-env` are *not* skipped
 * silently: seeing either escalates.
 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

export interface Token {
	/** The token with quotes removed and `$'…'` decoded. */
	value: string;
	/** True when the token was written with any quoting or expansion syntax. */
	hadExpansion: boolean;
	/** True when an unquoted, unescaped `*`, `?` or `[` makes the token a glob bash expands. */
	glob?: boolean;
}

export interface Segment {
	tokens: Token[];
	/** Redirection targets found in this segment, in written order. */
	redirects: string[];
	raw: string;
}

/** Decode the escapes bash understands inside `$'…'`. */
function decodeAnsiC(body: string): string {
	return body.replace(/\\(n|t|r|\\|'|"|a|b|f|v|0|x[0-9a-fA-F]{1,2})/g, (match, escape: string) => {
		switch (escape) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "\\":
				return "\\";
			case "'":
				return "'";
			case '"':
				return '"';
			case "a":
				return "\x07";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "0":
				return "\0";
			default:
				return escape.startsWith("x") ? String.fromCharCode(Number.parseInt(escape.slice(1), 16)) : match;
		}
	});
}

/**
 * Syntax through which a command can run something other than what its
 * visible words say. The permission matcher refuses to let a prefix/wildcard
 * allow rule cover a command carrying any of it (the user approved `npm test
 * …`, not whatever `$(…)` evaluates to), and the pre-gate escalates on it.
 */
export function hasInjectionSyntax(command: string): string | undefined {
	if (/\$\(/.test(command)) return "uses command substitution $( )";
	if (/(^|[^\\])`/.test(command)) return "uses backtick command substitution";
	if (/[<>]\(/.test(command)) return "uses process substitution";
	if (/\beval\b|\bexec\b/.test(command)) return "uses eval/exec";
	if (/\|\s*(bash|sh|zsh|python|perl|node|ruby)\b/.test(command)) return "pipes into an interpreter";
	if (/base64\s+(-d|--decode)/.test(command)) return "decodes base64, which can hide the real command";
	return undefined;
}

/** Syntax we do not model at all; its presence alone forces escalation. */
export function hasUnmodelledSyntax(command: string): string | undefined {
	if (command.includes("\n")) return "spans multiple lines";
	const injection = hasInjectionSyntax(command);
	if (injection) return injection;
	if (/<<</.test(command)) return "uses a here-string";
	if (/<</.test(command)) return "uses a heredoc";
	// Brace expansion resolves to paths we cannot enumerate (review finding N3).
	if (/\{[^{}]*,[^{}]*\}/.test(command)) return "uses brace expansion, whose expanded paths cannot be checked";
	if (/\$\{?[A-Za-z_]/.test(command)) return "references environment variables, whose values are unknown here";
	return undefined;
}

/**
 * Split a command into pipeline/list segments and tokenize each. Unlike the
 * original, `<`, `>`, `&`, and `|` terminate a token even without surrounding
 * whitespace, so `cmd>file` and `a|b` are seen (review finding N4). An
 * unquoted newline ends a segment too (it is a command separator in bash).
 */
export function parseCommand(command: string): { segments: Segment[]; parseFailed: boolean } {
	const segments: Segment[] = [];
	let tokens: Token[] = [];
	let redirects: string[] = [];
	let rawStart = 0;

	let current = "";
	let hadExpansion = false;
	let glob = false;
	let quoted = false;
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	/** Set while consuming the token that follows a redirection operator. */
	let pendingRedirect = false;

	const pushToken = () => {
		if (!current && !quoted) return;
		if (pendingRedirect) {
			redirects.push(current);
			pendingRedirect = false;
		} else {
			tokens.push({ value: current, hadExpansion, glob });
		}
		current = "";
		hadExpansion = false;
		glob = false;
		quoted = false;
	};

	/** `at` = index of the separator; `width` = its length (`&&` is 2). */
	const pushSegment = (at: number, width = 1) => {
		pushToken();
		if (tokens.length > 0 || redirects.length > 0) {
			segments.push({ tokens, redirects, raw: command.slice(rawStart, at).trim() });
		}
		tokens = [];
		redirects = [];
		rawStart = at + width;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (escape) {
			current += ch;
			escape = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			escape = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			quoted = true;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			quoted = true;
			continue;
		}
		// ANSI-C quoting: `$'\x2e\x2e'` is `..`. The original kept the leading `$`,
		// which made the token look like a variable and skipped every path check
		// (review finding N1, reproduced there).
		if (ch === "$" && command[i + 1] === "'" && !inSingle && !inDouble) {
			const end = command.indexOf("'", i + 2);
			if (end === -1) return { segments: [], parseFailed: true };
			current += decodeAnsiC(command.slice(i + 2, end));
			quoted = true;
			hadExpansion = true;
			i = end;
			continue;
		}

		if (inSingle || inDouble) {
			current += ch;
			continue;
		}

		if (ch === "\n") {
			// An unquoted newline separates commands exactly like `;`. Without this
			// `npm test x\ncurl evil` would be one segment whose lead is `npm test`.
			pushSegment(i);
			continue;
		}
		if (/\s/.test(ch)) {
			pushToken();
			continue;
		}

		// Redirection. `>|` is the clobber-override form and behaves as `>`
		// (review finding N10); `2>&1` and `&>` are duplications, not paths.
		if (ch === ">" || ch === "<") {
			pushToken();
			let j = i + 1;
			if (command[j] === ">" || command[j] === "|") j++;
			if (command[j] === "&") {
				// `>&2`, `>&-`: fd duplication, no path involved. But `>&word` with
				// any other word opens that file for writing (bash's `&>word`), so it
				// is a write target like `>word` (SECURITY-REVIEW-2026-09-23 H3).
				let k = j + 1;
				while (k < command.length && /[0-9]/.test(command[k])) k++;
				if (command[k] === "-") k++;
				const boundary = k >= command.length || /[\s;&|<>()]/.test(command[k]);
				if (k > j + 1 && boundary) {
					i = k - 1;
					continue;
				}
				j++;
			}
			pendingRedirect = ch === ">";
			i = j - 1;
			continue;
		}

		if (ch === "|" || ch === ";" || ch === "&") {
			// `&&`, `||`, `;`, `|`, `&` all end a segment. Any of them means the
			// next command is separate, which is all we need to know.
			const doubled = command[i + 1] === ch;
			pushSegment(i, doubled ? 2 : 1);
			if (doubled) i++;
			continue;
		}

		if (ch === "*" || ch === "?" || ch === "[") glob = true;
		current += ch;
	}

	if (escape || inSingle || inDouble) return { segments: [], parseFailed: true };
	pushSegment(command.length);
	return { segments, parseFailed: false };
}

/** Peel wrappers to the command that actually runs (review finding N5). */
export function resolvePayload(tokens: Token[]): { command: string; args: Token[]; peeled: string[] } {
	const peeled: string[] = [];
	let index = 0;

	for (;;) {
		// Leading `VAR=value` assignments are not the command.
		while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) index++;
		if (index >= tokens.length) return { command: "", args: [], peeled };

		const name = commandName(tokens[index].value);
		if (!TRANSPARENT_WRAPPERS.has(name)) {
			return { command: name, args: tokens.slice(index + 1), peeled };
		}

		peeled.push(name);
		index++;
		// Step over the wrapper's own flags and their values.
		while (index < tokens.length && tokens[index].value.startsWith("-")) {
			const flag = tokens[index].value;
			index++;
			if (WRAPPER_VALUE_OPTIONS.has(flag) && index < tokens.length) index++;
		}
		// `timeout 30 cmd` — a bare duration is not the payload.
		while (index < tokens.length && /^[0-9]+[smhd]?$/.test(tokens[index].value)) index++;
	}
}

/**
 * A segment's tokens normalised for command-position checks: subshell parens
 * stripped from the head token only (`(cd` → `cd` — a later argument may
 * legitimately begin with `(`), leading `do`/`then`/`else` keywords skipped,
 * and as many trailing `)`s stripped off the last token as `(`s were opened at
 * the head, so `(git stash)` still matches subcommand `stash`. A subshell
 * whose closing paren lands in a *different* segment (`(a && git stash)`) is
 * a known limitation — the closer is only balanced within one segment.
 * Used by the bash/worktree guard pipelines, not by the escalation analyzer.
 */
export function leadTokens(seg: Segment): Token[] {
	const tokens = [...seg.tokens];
	let i = 0;
	let opened = 0;
	for (;;) {
		while (i < tokens.length) {
			const value = tokens[i].value;
			const lead = /^[({]+/.exec(value)?.[0] ?? "";
			if (lead.length === 0) break;
			opened += (lead.match(/\(/g) ?? []).length;
			const stripped = value.slice(lead.length);
			if (stripped.length === 0) {
				i++;
				continue;
			}
			tokens[i] = { ...tokens[i], value: stripped };
			break;
		}
		if (i < tokens.length && ["do", "then", "else"].includes(tokens[i].value)) {
			i++;
			continue;
		}
		break;
	}
	if (opened > 0 && tokens.length > i) {
		const last = tokens.length - 1;
		const trailing = /\)+$/.exec(tokens[last].value)?.[0];
		if (trailing) {
			const strip = Math.min(trailing.length, opened);
			tokens[last] = { ...tokens[last], value: tokens[last].value.slice(0, tokens[last].value.length - strip) };
		}
	}
	return tokens.slice(i);
}

/**
 * Superset of GIT_GLOBAL_VALUE_FLAGS for *locating* the subcommand, not for
 * judging safety: `-c`/`--config-env` are included here because they do take a
 * value, while the escalation analyzer above deliberately refuses to skip them.
 */
const GIT_LOCATOR_VALUE_FLAGS = new Set([...GIT_GLOBAL_VALUE_FLAGS, "-c", "--config-env"]);

/** The git subcommand and the tokens after it, global flags skipped. */
export function gitSubcommand(args: Token[]): { sub?: string; rest: Token[] } {
	let i = 0;
	while (i < args.length) {
		const value = args[i].value;
		if (!value.startsWith("-")) return { sub: value, rest: args.slice(i + 1) };
		i += GIT_LOCATOR_VALUE_FLAGS.has(value) ? 2 : 1;
	}
	return { rest: [] };
}

/** Basename of a command token, `.exe` stripped, lowercased. */
function commandName(token: string): string {
	const withForwardSlashes = token.trim().toLowerCase().replace(/\\/g, "/");
	const base = withForwardSlashes.slice(withForwardSlashes.lastIndexOf("/") + 1);
	return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/**
 * Whether a token names a path. Unlike the original, bare `.` and `..` count
 * (review finding N2) — `rm -rf ..` deletes the parent directory and the
 * original saw no path at all.
 */
function looksLikePath(value: string): boolean {
	if (!value || value.startsWith("-")) return false;
	if (value.includes("://")) return false;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return false;
	if (value === "." || value === "..") return true;
	if (value === "~" || value.startsWith("~/")) return true;
	return value.startsWith("/") || value.includes("/");
}

/** Leading assignments that change nothing a command runs or reads: locale and display only. */
const INERT_ASSIGNMENTS = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|COLUMNS|LINES)$/;

/**
 * A `~` word other than `~` and `~/…`: bash expands `~name` to that user's
 * home and `~-`/`~+` to `$OLDPWD`/`$PWD`, which `toAbsolute` would read as a
 * directory literally named `~name` inside the working directory.
 */
export function isUnknownTilde(value: string): boolean {
	return value.startsWith("~") && value !== "~" && !value.startsWith("~/");
}

/** Whether a directory entry exists at `absolute` (a dangling symlink counts). */
function entryExists(absolute: string): boolean {
	try {
		lstatSync(absolute);
		return true;
	} catch {
		return false;
	}
}

/**
 * A bash glob (one path component) as a RegExp: `*`, `?`, `[…]`/`[!…]`,
 * everything else literal. Undefined when JavaScript cannot compile the
 * bracket expression (`[z-a]`), which bash accepts and matches nothing with.
 */
export function globComponentRegex(glob: string): RegExp | undefined {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else if (ch === "[") {
			// A `]` first in the set, after any `!`/`^`, is a member, not the end.
			const negation = glob[i + 1] === "!" || glob[i + 1] === "^" ? 1 : 0;
			const close = glob.indexOf("]", i + 2 + negation);
			if (close === -1) {
				out += "\\[";
				continue;
			}
			let body = glob.slice(i + 1, close);
			const negated = body.startsWith("!") || body.startsWith("^");
			if (negated) body = body.slice(1);
			out += `[${negated ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
			i = close;
		} else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	try {
		return new RegExp(`^${out}$`);
	} catch {
		return undefined;
	}
}

/**
 * The words bash expands a glob operand to, or undefined when the check cannot
 * enumerate them: a glob in a directory component, a component starting with
 * `.` (bash before 5.2 matches `.` and `..` with `.*` or `.?`), a bracket
 * expression JavaScript cannot compile, or more than 2,000 matches. Only the last component is expanded, as bash would with
 * `dotglob`, `globstar` and `nocaseglob` off (their non-interactive defaults).
 * No match leaves the word as written, as bash does without `nullglob`.
 */
function expandGlob(cwd: string, pattern: string, home: string): string[] | undefined {
	const slash = pattern.lastIndexOf("/");
	const dirPart = slash >= 0 ? pattern.slice(0, slash) : "";
	const leaf = slash >= 0 ? pattern.slice(slash + 1) : pattern;
	if (!leaf || /[*?[]/.test(dirPart) || leaf.startsWith(".")) return undefined;
	if (isUnknownTilde(dirPart)) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(toAbsoluteBash(cwd, slash >= 0 ? dirPart || "/" : ".", home));
	} catch {
		return [pattern];
	}
	const regex = globComponentRegex(leaf);
	if (!regex) return undefined;
	const matches = entries.filter((entry) => !entry.startsWith(".") && regex.test(entry));
	if (matches.length > 2_000) return undefined;
	if (matches.length === 0) return [pattern];
	return matches.map((entry) => (slash >= 0 ? `${dirPart}/${entry}` : entry));
}

/** The file named by a `-o FILE` / `-oFILE` / `--output=FILE` flag, if present. */
function outputFlagTarget(args: Token[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const value = args[i].value;
		if (value === "-o" || value === "--output") return args[i + 1]?.value;
		if (value.startsWith("--output=")) return value.slice("--output=".length);
		if (value.startsWith("-o") && value.length > 2) return value.slice(2);
	}
	return undefined;
}

/**
 * Decide git: only an explicitly read-only subcommand, preceded by global
 * options from `GIT_GLOBAL_SAFE` or an in-project `-C`, and carrying only the
 * options its table names, is safe. Returns undefined when safe, else the
 * reason to escalate.
 */
function gitEscalationReason(args: Token[], isDirOutsideCwd: (dir: string) => boolean, onFileReads: (words: Token[]) => void): string | undefined {
	let index = 0;
	while (index < args.length) {
		const token = args[index].value;
		if (!token.startsWith("-")) break;
		// `-c key=value` / `--config-env` can reconfigure git into executing an arbitrary helper.
		if (token === "-c" || token.startsWith("-c") || token === "--config-env" || token.startsWith("--config-env=")) {
			return "passes git -c/--config-env, which can turn a read into code execution";
		}
		if (token === "-C") {
			const dir = args[index + 1]?.value;
			// `-C` retargets git at another directory; outside the working directory
			// the operation is no longer provably in-project (was review gap: `git
			// -C /etc status` classified safe).
			if (!dir || isDirOutsideCwd(dir)) return `runs git -C ${dir ?? ""}, which points outside the working directory`;
			index += 2;
			continue;
		}
		if (GIT_GLOBAL_SAFE.has(token)) {
			index++;
			continue;
		}
		// `--git-dir`, `--work-tree`, `--exec-path`, `--namespace` and every other
		// global option can point git at a repository or configuration this check
		// has not seen, in-project or not (SECURITY-REVIEW-2026-09-23 H2).
		const eq = token.indexOf("=");
		const flag = eq > 0 ? token.slice(0, eq) : token;
		const value = eq > 0 ? token.slice(eq + 1) : undefined;
		if ((flag === "--git-dir" || flag === "--work-tree") && value !== undefined && isDirOutsideCwd(value)) {
			return `runs git ${flag} ${value}, which points outside the working directory`;
		}
		return `passes git ${flag}, which can point git at another repository or configuration`;
	}
	const subcommand = args[index]?.value;
	if (!subcommand) return undefined; // bare `git` prints help
	const spec = GIT_SUBCOMMAND_SPECS[subcommand];
	if (!spec) return `runs git ${subcommand}, which is not a read-only subcommand`;
	const check = checkOptions(spec, args.slice(index + 1));
	if (!check.ok) return `runs git ${subcommand} and ${check.reason}`;
	if (!gitOperandsAllowed(subcommand, check.parsed)) {
		return `runs git ${subcommand} with an operand and no --list, which creates a ref`;
	}
	if (GIT_FILE_OPERANDS.has(subcommand)) onFileReads(check.parsed.positionals);
	return undefined;
}

/**
 * Subcommands whose operands can be files git reads outside the repository.
 * `git diff <path> <path>` goes `--no-index` by itself when either path is
 * outside the work tree or there is no repository, and reads both files
 * (findings §25). Every operand is read-checked, revisions included: a
 * revision is not a path unless a file of that name exists, and one that
 * resolves inside the working directory passes.
 */
const GIT_FILE_OPERANDS = new Set(["diff"]);

/**
 * For a git command the options already proved read-only: why the checkout it
 * runs in (after every `-C`, each relative to the last) could still make it
 * run a program (git-checkout-programs.ts), or undefined.
 */
function gitCheckoutReason(args: Token[], cwd: string, home: string, seen: Map<string, string | undefined>): string | undefined {
	let dir = cwd;
	for (let index = 0; index < args.length && args[index].value.startsWith("-"); index++) {
		if (args[index].value === "-C" && args[index + 1]) dir = toAbsoluteBash(dir, args[++index].value, home);
	}
	// Memoized for one analysis only: nothing runs between its segments, but the
	// model can rewrite `.git/config` between calls.
	if (!seen.has(dir)) seen.set(dir, checkoutGitRunsProgram(dir, home));
	const why = seen.get(dir);
	return why && `runs git where ${why}`;
}

export interface AnalyzeInput {
	command: string;
	cwd: string;
	home: string;
	/**
	 * Directories protected at runtime beyond protected-paths.ts's static list
	 * (pi's own agent dir — permissions/matcher.ts `DecideInput.protectedDirs`).
	 * A redirect landing inside one escalates like a write to `.git/hooks`.
	 */
	protectedDirs?: string[];
	/**
	 * REALPATH-resolved directories a read-only command may read from besides
	 * the working directory without escalating: the harness's own session dirs
	 * (memory, scratchpad, persisted results, this project's transcripts —
	 * permissions/matcher.ts `DecideInput.sessionDirPath`), resolved once per
	 * session by the caller (compared against realpaths here, unresolved). Reads
	 * only; the write and delete checks never consult this list.
	 */
	readableRoots?: string[];
}

/**
 * Classify a shell command. Never denies — see the module contract above.
 */
export function analyzeShellCommand({ command, cwd, home, protectedDirs = [], readableRoots = [] }: AnalyzeInput): ShellEvidence {
	const checkoutReasons = new Map<string, string | undefined>();
	const evidence: ShellEvidence = {
		verdict: "safe",
		notes: [],
		commands: [],
		writes: [],
		sensitivePaths: [],
		executionPrimitives: [],
		protectedPaths: [],
		network: [],
		outsideReads: [],
		readOnlyOutside: false,
		containedNonNetwork: false,
		wholeTree: false,
	};
	/**
	 * Set by any escalation reason that is NOT a bare in-project mutation — i.e.
	 * anything meaning the command reaches outside the project or cannot be fully
	 * accounted for. When it stays false through an escalation, the only blocker
	 * was in-project mutation, and the containment gate may consult recoverability.
	 */
	let uncontained = false;
	/** Set by any escalation that is not an outside-cwd read (see readOnlyOutside). */
	let escalatedBeyondReads = false;
	const escalate = (note: string, opts?: { contained?: boolean; outsideRead?: boolean }) => {
		evidence.verdict = "escalate";
		if (!opts?.contained) uncontained = true;
		if (!opts?.outsideRead) escalatedBeyondReads = true;
		if (!evidence.notes.includes(note)) evidence.notes.push(note);
	};

	const trimmed = command.trim();
	if (!trimmed) return { ...evidence, verdict: "escalate", notes: ["empty command"] };

	const unmodelled = hasUnmodelledSyntax(trimmed);
	if (unmodelled) escalate(unmodelled);

	const { segments, parseFailed } = parseCommand(trimmed);
	if (parseFailed) {
		escalate("could not be parsed (unbalanced quotes), so nothing about it is known");
		return evidence;
	}

	/**
	 * Containment is checked against the *resolved* working directory. Write
	 * targets come back realpath'd, and on macOS the working directory often sits
	 * under a symlinked root (`/var/folders/…` → `/private/var/folders/…`), so
	 * comparing a resolved target against an unresolved base reports every
	 * in-project write as an escape.
	 */
	const containmentRoot = resolveForContainment(cwd) ?? cwd;

	/** `cd` changes what later relative paths mean; the original never tracked it (F6/N12). */
	let effectiveCwd = cwd;

	/**
	 * Resolve a write-target token, record it as evidence, and escalate on any
	 * target that cannot be resolved, escapes the working directory, or names a
	 * credential / execution-primitive path. Shared by redirections, mutating
	 * command positionals, and output-flag targets so all writes get one check.
	 */
	const checkWriteTarget = (token: string) => {
		if (token === "/dev/null") return;
		// A `~name`/`~-` target or a glob lands wherever bash expands it, which
		// this check cannot know (SECURITY-REVIEW-2026-09-23 M2).
		if (isUnknownTilde(token) || /[*?[]/.test(token)) {
			evidence.writes.push({ token, absolute: token, outsideCwd: true });
			escalate(`writes to ${token}, which bash expands to a path this check cannot resolve`);
			return;
		}
		const absolute = toAbsoluteBash(effectiveCwd, token, home);
		const resolved = resolveForContainment(absolute);
		const outsideCwd = resolved === undefined || !isWithin(containmentRoot, resolved);
		evidence.writes.push({ token, absolute, resolved, outsideCwd });
		if (resolved === undefined) {
			escalate(`writes to ${token}, which could not be resolved to a real path`);
		} else if (outsideCwd) {
			escalate(`writes to ${token}, which is outside the working directory`);
		}
		if (isSensitivePath(absolute) && !evidence.sensitivePaths.includes(token)) {
			evidence.sensitivePaths.push(token);
			escalate(`writes to ${token}, a credential or secret path`);
		}
		if (isExecutionPrimitivePath(absolute) && !evidence.executionPrimitives.includes(token)) {
			evidence.executionPrimitives.push(token);
			escalate(`writes to ${token}, whose contents execute later without further approval`);
		}
		// Same list the write/edit tools are gated on: an in-project redirect onto
		// `.cargo/config.toml`, `.claude/agents/x.md`, or `lefthook.yml` reconfigures
		// the toolchain or the agent itself, so containment says nothing about it.
		const protectedTarget = [absolute, resolved].some(
			(candidate) =>
				candidate !== undefined &&
				(isProtectedPath(candidate, effectiveCwd) || protectedDirs.some((dir) => isWithin(dir, candidate))),
		);
		if (protectedTarget && !evidence.protectedPaths.includes(token)) {
			evidence.protectedPaths.push(token);
			escalate(`writes to ${token}, a protected tooling or agent configuration path`);
		}
	};

	for (const segment of segments) {
		// Redirection targets are writes regardless of the command word: a bare
		// `> file` truncates/creates it with no command at all, and `git log > file`
		// writes it too. Check them first so the command-specific `continue`s below
		// (cd/git) can never skip a redirect (was review gap: bare-redirect writes and
		// read-only-command redirects were fast-pathed to "safe").
		for (const token of segment.redirects) checkWriteTarget(token);

		// A leading `NAME=value` changes what the command runs or reads: git takes
		// its repository and configuration from GIT_* variables (the same
		// capability `git -c` is refused for), loaders and pagers from others, and
		// a bare `PATH=./bin` segment changes which program every later word runs.
		// Only locale and display variables are inert (SECURITY-REVIEW-2026-09-23 H2).
		for (const token of segment.tokens) {
			const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token.value)?.[1];
			if (!assigned) break;
			if (!INERT_ASSIGNMENTS.test(assigned)) escalate(`sets ${assigned}, which can change what the command runs or reads`);
		}

		const { command: name, args, peeled } = resolvePayload(segment.tokens);
		if (!name) {
			// A wrapper with nothing to wrap is a command of its own: a bare `env`
			// (or `env -i`, `nice`) prints the whole process environment / state.
			// Until 2026-09-05 this fell through as "safe" (H2).
			if (peeled.length > 0) {
				escalate(
					peeled.includes("env")
						? "runs env with no command, which prints the whole process environment"
						: `runs ${peeled.join(" → ")} with no command to wrap`,
				);
			}
			continue;
		}
		evidence.commands.push(name);
		if (peeled.length > 0) {
			// A transparent wrapper (timeout, env, nice) leaves the payload's own
			// arguments visible, so an in-project payload stays contained; xargs is
			// the exception — its targets come from stdin, unknown to this check.
			escalate(`wraps the real command in ${peeled.join(" → ")}, so ${name} is what actually runs`, {
				contained: !peeled.includes("xargs"),
			});
		}

		if (NETWORK_COMMANDS.has(name)) {
			evidence.network.push(name);
			escalate(`runs ${name}, which can reach the network`);
		}

		// Every positional token is checked against the credential denylist,
		// whether or not it looks like a path: `cd .kube && cat config` reads
		// `~/.kube/config` through two tokens that each look harmless (N12).
		for (const { value } of args) {
			if (!value || value.startsWith("-")) continue;
			const absolute = toAbsoluteBash(effectiveCwd, value, home);
			if (isSensitivePath(value) || isSensitivePath(absolute)) {
				// The *original* token, never the resolved/expanded form (N18).
				if (!evidence.sensitivePaths.includes(value)) evidence.sensitivePaths.push(value);
				escalate(`names ${value}, which is a credential or secret path`);
			}
			if (isExecutionPrimitivePath(absolute)) {
				if (!evidence.executionPrimitives.includes(value)) evidence.executionPrimitives.push(value);
				escalate(`touches ${value}, whose contents execute later without further approval`);
			}
		}

		if (name === "cd") {
			const target = args.find((token) => !token.value.startsWith("-"))?.value;
			if (target) {
				effectiveCwd = toAbsoluteBash(effectiveCwd, target, home);
				escalate(`changes directory to ${target}, so later paths in this command resolve elsewhere`);
			}
			continue;
		}

		/**
		 * A word a read-only command reads. It escalates when it resolves outside
		 * the working directory and the readable roots, or onto a credential path
		 * — judged where it RESOLVES, so an in-project symlink named `notes` that
		 * points at a key file is the key file (SECURITY-REVIEW-2026-09-23 M1). A
		 * `~name`/`~-` word and a glob that could reach `..` are paths bash
		 * expands to places this check cannot see (M2); an ordinary glob is
		 * expanded one level here and every match is judged.
		 */
		const escalateOutsideRead = (value: string, why: string) => {
			if (!evidence.outsideReads.includes(value)) evidence.outsideReads.push(value);
			escalate(`reads ${value}, ${why}`, { outsideRead: true });
		};
		const checkRead = (word: { value: string; glob?: boolean }) => {
			const value = word.value;
			if (!value) return;
			if (isUnknownTilde(value)) {
				escalateOutsideRead(value, "which bash expands to a directory outside what this check can see");
				return;
			}
			const targets = word.glob ? expandGlob(effectiveCwd, value, home) : [value];
			if (targets === undefined) {
				escalateOutsideRead(value, "a glob whose matches cannot be checked");
				return;
			}
			for (const target of targets) {
				const absolute = toAbsoluteBash(effectiveCwd, target, home);
				if (!looksLikePath(target) && !entryExists(absolute)) continue;
				const resolved = resolveForContainment(absolute);
				if (resolved !== undefined && isSensitivePath(resolved) && !isSensitivePath(absolute)) {
					if (!evidence.sensitivePaths.includes(value)) evidence.sensitivePaths.push(value);
					escalate(`reads ${value}, which resolves to a credential or secret path`);
				}
				if (resolved !== undefined && (isWithin(containmentRoot, resolved) || readableRoots.some((root) => isWithin(root, resolved)))) continue;
				escalateOutsideRead(value, "which is outside the working directory");
			}
		};

		if (name === "git") {
			// `git reset --hard` is an in-project whole-tree discard: escalate, but
			// mark it contained so the recoverability gate can clear it when the tree
			// is clean. Any other non-read-only git subcommand is uncontained.
			if (isWholeTreeGitReset(args)) {
				if (hasGitRetargetFlag(args)) {
					// The reset acts on whatever -C/--git-dir/--work-tree names, not on
					// the working directory the recoverability judge would inspect.
					escalate("runs git reset --hard against another tree (-C/--git-dir/--work-tree), which cannot be judged here");
					continue;
				}
				evidence.wholeTree = true;
				escalate("runs git reset --hard, which discards uncommitted changes in the working tree", {
					contained: true,
				});
				continue;
			}
			const fileReads: Token[] = [];
			const reason =
				gitEscalationReason(
					args,
					(dir) => {
						if (isUnknownTilde(dir)) return true;
						const resolved = resolveForContainment(toAbsoluteBash(effectiveCwd, dir, home));
						return resolved === undefined || !isWithin(containmentRoot, resolved);
					},
					(words) => fileReads.push(...words),
				) ?? gitCheckoutReason(args, effectiveCwd, home, checkoutReasons);
			if (reason) escalate(reason);
			// Resolved against the working directory even under `-C <dir>`: that
			// dir is inside it (or git escalated above), and a relative path that
			// stays inside from here stays inside from any deeper directory.
			else for (const word of fileReads) checkRead(word);
			continue;
		}

		if (SCRIPT_INTERPRETERS.has(name)) {
			escalate(`runs ${name}, whose script can read and write files this check cannot see`);
		}

		const isMutation = MUTATION_COMMANDS.has(name);
		const isDelete = DELETE_COMMANDS.has(name);
		// A delete confined to in-project paths is what the containment gate exists
		// to clear (subject to recoverability); any other mutation (cp/mv/tar/…)
		// stays uncontained and reaches the classifier as before.
		if (isMutation) escalate(`runs ${name}, which modifies the filesystem`, { contained: isDelete });


		// A read-only command is proved read-only by its options, not its name:
		// each option must be in the command's table (read-only-options.ts), so
		// `rg --pre=<prog>`, `tree -o f` and `uniq in out` escalate
		// (SECURITY-REVIEW-2026-09-23 H1). Its operands, and the files named by
		// options such as `grep -f`, are then read-checked.
		if (name === "find") {
			const find = checkFind(args);
			if (!find.ok) escalate(find.reason);
			else for (const word of find.paths) checkRead(word);
		} else if (READ_ONLY_COMMANDS.has(name)) {
			const check = checkOptions(READ_ONLY_SPECS[name], args);
			if (!check.ok) {
				escalate(`runs ${name} and ${check.reason}`);
			} else {
				const spec = READ_ONLY_SPECS[name];
				const operandReason = spec.operandReason?.(check.parsed.positionals);
				if (operandReason) escalate(operandReason);
				const operands = [...check.parsed.positionals];
				// A pattern-first command's first operand is its pattern, unless an
				// option (`-e PAT`, `-f FILE`) supplies it; jq's first is its program.
				const patternFirst = PATTERN_FIRST_COMMANDS.has(name) && ![...check.parsed.seen].some((option) => PATTERN_OPTIONS.has(option));
				if (patternFirst || spec.programFirst) operands.shift();
				const reads = NO_FILE_OPERANDS.has(name) ? check.parsed.fileValues : [...operands, ...check.parsed.fileValues];
				for (const word of reads) checkRead(word);
			}
		} else if (!isMutation) {
			escalate(`runs ${name}, which is not on the read-only allowlist`);
		}

		// The positional destinations of writing commands are the paths that get
		// written. (Redirections were already handled at the top of the loop.)
		const writeTokens: string[] = [];
		if (isDelete) {
			// A delete's targets are every non-flag positional, bare names included
			// (`rm notes.txt` has no slash but is still a real target the
			// recoverability gate must see). A glob target cannot be enumerated, so
			// it drops out of containment — the command then reaches the classifier.
			for (const token of args) {
				if (token.value.startsWith("-")) continue;
				if (hasGlob(token.value)) {
					escalate(`targets ${token.value}, a glob whose expansion cannot be checked`);
					continue;
				}
				writeTokens.push(token.value);
			}
		} else if (isMutation) {
			const positionals = args.filter((token) => !token.value.startsWith("-") && looksLikePath(token.value));
			// For cp/mv/rsync/ln the destination is last; for the rest every
			// positional is a candidate target.
			if (["cp", "mv", "rsync", "ln", "install"].includes(name)) {
				const last = positionals[positionals.length - 1];
				if (last) writeTokens.push(last.value);
			} else {
				writeTokens.push(...positionals.map((token) => token.value));
			}
			for (const { value } of args) {
				if (value.startsWith("of=")) writeTokens.push(value.slice(3)); // dd
			}
		}

		// A few otherwise-read-only commands write when handed an output flag.
		// `sort -o FILE` / `sort --output=FILE` truncates/creates FILE, so it must
		// not be fast-pathed as a pure read (was review gap: `sort -o` classified safe).
		if (name === "sort") {
			const outTarget = outputFlagTarget(args);
			if (outTarget !== undefined) {
				escalate("runs sort with -o/--output, which writes a file");
				writeTokens.push(outTarget);
			}
		}

		for (const token of writeTokens) checkWriteTarget(token);
	}

	// The command escalated, but every reason was an in-project delete/whole-tree
	// reset — nothing reached outside the project, the network, or the unknown. The
	// containment gate may now consult git-recoverability (auto-mode/recoverability).
	evidence.containedNonNetwork = evidence.verdict === "escalate" && !uncontained;
	evidence.readOnlyOutside = evidence.verdict === "escalate" && !escalatedBeyondReads;

	return evidence;
}
