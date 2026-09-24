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
import { lstatSync, readdirSync, statSync } from "node:fs";
import {
	GIT_GLOBAL_SAFE,
	GIT_SUBCOMMAND_SPECS,
	PATTERN_OPTIONS,
	READ_ONLY_SPECS,
	checkFind,
	checkOptions,
	gitOperandsAllowed,
} from "./read-only-options.ts";
import { parseCommand, scopedTracker, type Segment, type Token } from "./shell-parse.ts";

export { decodeAnsiC, LOOPS, parseCommand, scopedTracker, type ParseResult, type Segment, type Token } from "./shell-parse.ts";

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

interface WrapperSpec {
	/** Options whose next word is a harmless value, skipped in both readings. */
	values?: readonly string[];
	/**
	 * Options whose value changes where or how the payload runs (`env -C`,
	 * `time -o`, `script -T`). The strict reading leaves the value in command
	 * position, so the command escalates; the wide reading skips it.
	 */
	unsafeValues?: readonly string[];
	/** Options whose value is a command line of its own (`flock -c`, `env -S`): the wide reading returns it. */
	scripts?: readonly string[];
	/** The first operand is a file, not the command (`flock LOCK cmd`, `script LOG cmd`). */
	fileFirst?: boolean;
	/** The first operand is a duration (`timeout 30 cmd`). */
	durationFirst?: boolean;
	/**
	 * Whether an in-project payload stays contained for the recoverability
	 * gate. xargs takes its targets from stdin, and flock and script write the
	 * file they are given, which nothing write-checks.
	 */
	contained: boolean;
	/** Peeled only for deny/ask forms; the pre-gate treats it as an unknown command. */
	denyFormsOnly?: boolean;
}

/**
 * Commands that run whatever follows them, and how each one takes its own
 * options. The original only knew three and never looked past them, so `env
 * rm -rf ~/Desktop` classified as a harmless `env` (review finding N5); one
 * shared value-option list later read `setsid -c` (a flag) and `stdbuf -o 1M`
 * wrong, so the real command slipped past deny rules
 * (PREGATE-REVIEW-2026-09-23 P6). `sudo`/`doas` are peeled for deny forms
 * only: the pre-gate peeling them would clear `sudo rm` as a contained delete.
 */
const WRAPPERS: Record<string, WrapperSpec> = {
	// `builtin cd x` runs the builtin `cd` (PR #12 review: it hid a `cd` from the worktree guard).
	builtin: { contained: true },
	caffeinate: { values: ["-t", "-w"], contained: true, denyFormsOnly: true },
	command: { contained: true },
	doas: { values: ["-u", "-a"], unsafeValues: ["-C"], contained: false, denyFormsOnly: true },
	env: { values: ["-u", "--unset"], unsafeValues: ["-C", "--chdir"], scripts: ["-S", "--split-string"], contained: true },
	flock: { values: ["-w", "--timeout", "-E", "--conflict-exit-code"], scripts: ["-c", "--command"], fileFirst: true, contained: false },
	ionice: { values: ["-c", "--class", "-n", "--classdata"], contained: true },
	nice: { values: ["-n", "--adjustment"], contained: true },
	nohup: { contained: true },
	script: {
		values: ["-t", "-E", "--echo", "-m", "--logging-format"],
		unsafeValues: ["-T", "--log-timing", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io"],
		scripts: ["-c", "--command"],
		fileFirst: true,
		contained: false,
	},
	setsid: { contained: true },
	stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], contained: true },
	sudo: {
		values: ["-u", "-g", "-h", "-p", "-r", "-t", "-U", "-T", "-a", "--user", "--group", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--auth-type"],
		unsafeValues: ["-C", "-D", "-R", "--close-from", "--chdir", "--chroot"],
		contained: false,
		denyFormsOnly: true,
	},
	time: { values: ["-f", "--format"], unsafeValues: ["-o", "--output"], contained: true },
	timeout: { values: ["-s", "--signal", "-k", "--kill-after"], durationFirst: true, contained: true },
	xargs: {
		values: ["-I", "-L", "-n", "-P", "-s", "-E", "-d", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--eof"],
		unsafeValues: ["-a", "--arg-file"],
		contained: false,
	},
};

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

/**
 * Commands that only print their arguments, so a command substitution among
 * them is safe once the substituted command is: its output is printed, not
 * read as an option, a path or a program (`echo "built $(date)"`). `echo`'s
 * options only change how it prints. `printf` is not here: `printf $(echo
 * -v) PATH ./bin` assigns a variable (PR #12 review).
 */
const PURE_OUTPUT = new Set(["echo"]);

/** A parameter bash sets itself (`$1`, `$@`, `$$`, `${#}`), as opposed to an environment variable. */
const SPECIAL_PARAMETER = /\$\{?[0-9@*#?$!-]/;

export interface Payload {
	command: string;
	args: Token[];
	/** The wrappers peeled, outermost first. */
	peeled: string[];
	/** Command-position words spelled with a directory (`./cat`, `bin/ls`, `/bin/rm`), as written. */
	pathNamed: string[];
	/** Wide reading only: command lines a wrapper option runs (`flock -c '…'`, `env -S '…'`). */
	scripts: string[];
}

/**
 * Peel wrappers to the command that actually runs (review finding N5).
 *
 * The two readings fail in opposite directions. `"strict"` (the default: the
 * pre-gate and the guards) peels only what it fully understands, so anything
 * else stays in command position and escalates. `"wide"` (deny/ask forms)
 * also skips the values of options that change where the payload runs,
 * returns the command lines wrapper options carry, and peels `sudo`/`doas`,
 * because a deny rule should see every command a line might run.
 */
export function resolvePayload(tokens: Token[], reading: "strict" | "wide" = "strict"): Payload {
	const wide = reading === "wide";
	const payload: Payload = { command: "", args: [], peeled: [], pathNamed: [], scripts: [] };
	let index = 0;

	const kind = (spec: WrapperSpec, option: string) =>
		spec.values?.includes(option) ? "value" : spec.unsafeValues?.includes(option) ? "unsafe" : spec.scripts?.includes(option) ? "script" : undefined;

	/**
	 * Skip the wrapper's own options; `--` ends them. A value may be attached,
	 * as getopt allows: `--chdir=/tmp`, `-C/tmp`, or last in a short cluster
	 * (`-iC/tmp`). Until 2026-09-24 only the separate spelling was recognised,
	 * so `env --chdir=/tmp rm -f a.txt` peeled as a contained delete and
	 * `env --split-string='rm …'` hid its script from deny rules.
	 */
	const skipOptions = (spec: WrapperSpec) => {
		while (index < tokens.length && tokens[index].value.startsWith("-")) {
			const word = tokens[index].value;
			if (word === "--") {
				index++;
				return;
			}
			let option: string | undefined;
			let attached: string | undefined;
			if (word.startsWith("--")) {
				const eq = word.indexOf("=");
				option = eq > 0 ? word.slice(0, eq) : word;
				attached = eq > 0 ? word.slice(eq + 1) : undefined;
			} else {
				for (let i = 1; i < word.length; i++) {
					if (!kind(spec, `-${word[i]}`)) continue;
					option = `-${word[i]}`;
					attached = word.slice(i + 1) || undefined;
					break;
				}
			}
			const type = option === undefined ? undefined : kind(spec, option);
			// Strict: an attached value that moves the payload or carries a script
			// stays in command position, so the command escalates uncontained.
			if (!wide && attached !== undefined && (type === "unsafe" || type === "script")) return;
			index++;
			if (type === undefined || attached !== undefined) {
				if (wide && type === "script" && attached !== undefined) payload.scripts.push(attached);
				continue;
			}
			if (index >= tokens.length) return;
			if (type === "value") index++;
			else if (wide && type === "unsafe") index++;
			else if (wide && type === "script") payload.scripts.push(tokens[index++].value);
		}
	};

	for (;;) {
		// Leading `VAR=value` assignments are not the command.
		while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) index++;
		if (index >= tokens.length) return payload;

		if (/[\\/]/.test(tokens[index].value)) payload.pathNamed.push(tokens[index].value);
		const name = commandName(tokens[index].value);
		const spec = WRAPPERS[name];
		if (!spec || (spec.denyFormsOnly && !wide)) {
			payload.command = name;
			payload.args = tokens.slice(index + 1);
			return payload;
		}

		payload.peeled.push(name);
		index++;
		skipOptions(spec);
		if (spec.fileFirst && index < tokens.length) {
			index++;
			// `flock LOCK -c '…'`: options may follow the file too.
			skipOptions(spec);
		}
		if (spec.durationFirst && index < tokens.length && /^[0-9.]+[smhd]?$/.test(tokens[index].value)) index++;
	}
}

/** Whether every peeled wrapper keeps an in-project payload contained (see `WrapperSpec.contained`). */
function wrappersContained(peeled: readonly string[]): boolean {
	return peeled.every((name) => WRAPPERS[name]?.contained);
}

/**
 * A segment's tokens from its command word on, for command-position checks.
 * `time` is a reserved word that the grammar reads as a command, so `time
 * { rm x; }` arrives as the words `time { rm x` (and a `}` command): a leading
 * `time`, its `-p`, and the `{`, `(` or `!` it times are skipped. The grammar
 * has already taken that punctuation out of every other command. Used by the
 * guards and the deny forms, not by the escalation analyzer.
 */
export function leadTokens(seg: Segment): Token[] {
	let i = 0;
	while (seg.tokens[i]?.value === "time") {
		i++;
		while (["-p", "--", "{", "(", "!"].includes(seg.tokens[i]?.value)) i++;
	}
	return seg.tokens.slice(i);
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
 * Whether an inert variable's VALUE keeps it inert. libc reads a file named by
 * `TZ=:/path` or `TZ=/path`, and a locale name with a `/` is a path too, so
 * only plain names pass: a zone name made of plain segments (`Asia/Tokyo`,
 * read from the system zoneinfo) for TZ, and no `/` at all for the rest
 * (PREGATE-REVIEW-2026-09-23 P4).
 */
function isInertValue(name: string, value: string): boolean {
	if (name === "TZ") return /^([A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*)?$/.test(value);
	return /^[A-Za-z0-9_.,@:+-]*$/.test(value);
}

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

/** Whether `resolved` (already realpath'd) is a directory. */
function isDirectory(resolved: string): boolean {
	try {
		return statSync(resolved).isDirectory();
	} catch {
		return false;
	}
}

const FOLLOWS_DIR_ENTRY_SYMLINKS = "reads through symbolic links inside it, which can read outside the working directory";

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

/** The directory git runs in: `cwd`, then each leading `-C <dir>` in turn, as git applies them. */
function gitWorkingDirectory(args: Token[], cwd: string, home: string): string {
	let dir = cwd;
	for (let index = 0; index < args.length; ) {
		const token = args[index].value;
		if (token === "-C") {
			const next = args[index + 1]?.value;
			if (next) dir = toAbsoluteBash(dir, next, home);
			index += 2;
		} else if (GIT_GLOBAL_SAFE.has(token)) {
			index++;
		} else {
			break;
		}
	}
	return dir;
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

	const { segments, parseFailed, unavailable, unknownQuoting, complex } = parseCommand(trimmed);
	if (parseFailed) {
		escalate(unavailable ? `could not be parsed: ${unavailable}` : "could not be parsed as bash, so nothing about it is known");
		return evidence;
	}
	if (unknownQuoting) escalate(unknownQuoting);
	if (complex) escalate(complex);

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
	/** The directory per subshell scope: a `cd` inside `$(…)` or `( … )` does not reach the parent. */
	const cwdByScope = scopedTracker(cwd);

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
	// `base` is where the reading program resolves a relative word (git's
	// final `-C` directory); bash still expands globs from the shell's cwd.
	const checkRead = (word: { value: string; glob?: boolean }, base = effectiveCwd) => {
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
			const absolute = toAbsoluteBash(base, target, home);
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

	for (const segment of segments) {
		effectiveCwd = cwdByScope.get(segment);
		// Redirection targets are writes regardless of the command word: a bare
		// `> file` truncates/creates it with no command at all, and `git log > file`
		// writes it too. Check them first so the command-specific `continue`s below
		// (cd/git) can never skip a redirect (was review gap: bare-redirect writes and
		// read-only-command redirects were fast-pathed to "safe").
		for (const token of segment.redirects) checkWriteTarget(token);
		// An input redirect (`tr a b < f`) opens `f` whatever the command is, so
		// it is read-checked even for a command that takes no file operands. A
		// literally named credential file is checked here too: checkRead only
		// catches one reached through a symlink, leaving the literal name to the
		// operand scan below, which never sees `inputs` (`cat < .env`).
		for (const word of segment.inputs) {
			if (isSensitivePath(word.value) || isSensitivePath(toAbsoluteBash(effectiveCwd, word.value, home))) {
				if (!evidence.sensitivePaths.includes(word.value)) evidence.sensitivePaths.push(word.value);
				escalate(`reads ${word.value} on stdin, which is a credential or secret path`);
			}
			checkRead(word);
		}
		if (segment.unknownTarget) escalate("redirects to or from a path an expansion computes, which cannot be resolved here");
		// `cat <<< "$TOKEN"` prints the environment's value as surely as `echo $TOKEN`.
		if (segment.expandsIntoInput) escalate("expands a parameter into the command's input, whose value is unknown here");

		// A word bash computes at run time. A parameter's value comes from the
		// environment (`$@` is empty in a `bash -c` line, so `cat $@/etc/passwd`
		// read as an in-project path); a substitution's output can be any words,
		// options included. The substituted commands are segments of their own
		// and judged below like any other.
		const dynamicKinds = new Set(segment.tokens.map((token) => token.dynamic).filter((kind) => kind !== undefined));
		if (dynamicKinds.has("variable")) {
			escalate(
				segment.tokens.some((token) => token.dynamic === "variable" && SPECIAL_PARAMETER.test(token.value))
					? "references a shell special parameter ($1, $@, $$, …), whose value is unknown here"
					: "references environment variables, whose values are unknown here",
			);
		}

		// A leading `NAME=value` changes what the command runs or reads: git takes
		// its repository and configuration from GIT_* variables (the same
		// capability `git -c` is refused for), loaders and pagers from others, and
		// a bare `PATH=./bin` segment changes which program every later word runs.
		// Only locale and display variables are inert (SECURITY-REVIEW-2026-09-23 H2).
		for (const token of segment.tokens) {
			const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token.value)?.[1];
			if (!assigned) break;
			const inert = INERT_ASSIGNMENTS.test(assigned) && isInertValue(assigned, token.value.slice(assigned.length + 1));
			if (!inert) escalate(`sets ${assigned}, which can change what the command runs or reads`);
		}

		const { command: name, args, peeled, pathNamed } = resolvePayload(segment.tokens);
		if (dynamicKinds.has("substitution") && !PURE_OUTPUT.has(name)) {
			escalate(`passes a command substitution's output to ${name || "the shell"}, and its words are unknown here`);
		}
		// `diff <(git show HEAD:a) a`: bash hands a read-only command a pipe from a command judged on its own.
		if (dynamicKinds.has("process-input") && !READ_ONLY_COMMANDS.has(name) && name !== "find") {
			escalate(`passes a <( ) pipe to ${name || "the shell"}, which is not a read-only command`);
		}
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
		// `./cat` or `bin/timeout` runs whatever file sits there, not the command
		// its basename names; Claude Code matches the command word exactly too.
		for (const word of pathNamed) escalate(`runs ${word}, a program named by its path, so its name says nothing about what it does`);
		if (peeled.length > 0) {
			// A transparent wrapper (timeout, env, nice) leaves the payload's own
			// arguments visible, so an in-project payload stays contained unless a
			// wrapper's spec says otherwise (xargs, flock, script).
			escalate(`wraps the real command in ${peeled.join(" → ")}, so ${name} is what actually runs`, {
				contained: wrappersContained(peeled),
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
				cwdByScope.set(segment, effectiveCwd);
				escalate(`changes directory to ${target}, so later paths in this command resolve elsewhere`);
			}
			continue;
		}

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
			// git resolves a relative operand from its final `-C` directory, not
			// the shell's: `git -C sub diff ../../x/data.txt a.txt` can climb out
			// from `sub` where the same word stays inside from the working directory.
			else {
				const gitCwd = gitWorkingDirectory(args, effectiveCwd, home);
				for (const word of fileReads) checkRead(word, gitCwd);
			}
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
				// `rg --files` lists files and takes no pattern, so every operand is a
				// path (PREGATE-REVIEW-2026-09-23 P3).
				const patternFirst =
					PATTERN_FIRST_COMMANDS.has(name) && !check.parsed.seen.has("--files") && ![...check.parsed.seen].some((option) => PATTERN_OPTIONS.has(option));
				if (patternFirst || spec.programFirst) operands.shift();
				const reads = NO_FILE_OPERANDS.has(name) ? check.parsed.fileValues : [...operands, ...check.parsed.fileValues];
				for (const word of reads) checkRead(word);
				// A command that dereferences the entries of a directory operand
				// (`diff dir1 dir2`) reads through any symlink one level inside it,
				// which the operand's own containment check never sees (A1).
				if (spec.dereferencesDirEntries && !spec.dereferencesDirEntries.some((option) => check.parsed.seen.has(option))) {
					for (const word of operands) {
						// A glob could expand to a directory this check cannot enumerate, so
						// it escalates rather than being skipped (code-review 2026-09-24).
						if (word.glob) {
							escalate(`runs ${name} on the glob ${word.value}, which could name a directory that ${FOLLOWS_DIR_ENTRY_SYMLINKS}`);
							break;
						}
						const resolved = resolveForContainment(toAbsoluteBash(effectiveCwd, word.value, home));
						if (resolved !== undefined && isDirectory(resolved)) {
							escalate(`runs ${name} on the directory ${word.value}, which ${FOLLOWS_DIR_ENTRY_SYMLINKS}`);
							break;
						}
					}
				}
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
