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

import { productReadOnlySubcommands } from "../profile/profile.ts";
import { isNameOperand } from "./product-read-only.ts";
import { isProtectedPath } from "../rules/protected-paths.ts";
import { isExecutionPrimitivePath, isSensitivePath } from "./sensitive.ts";
import { dirname } from "node:path";
import { isWithin, resolveForContainment, resolveThroughLinks, toAbsoluteBash, touchesGuardedPath } from "./paths.ts";
import { type CheckoutProgram, checkoutGitRunsProgram, READ_HOOKS } from "./git-checkout-programs.ts";
import { findGitRoot } from "../context/git.ts";
import { lstatSync, readdirSync, statSync } from "node:fs";
import {
	GIT_GLOBAL_SAFE,
	GIT_SUBCOMMAND_SPECS,
	PATTERN_OPTIONS,
	READ_ONLY_SPECS,
	checkFind,
	checkOptions,
	gitOperandsAllowed,
	table,
	type OptionSpec,
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
	/**
	 * The glob operands of a removing or moving command (`rm`, `rmdir`,
	 * `shred`, `truncate`, `mv`), expanded against the filesystem as bash would
	 * (`expandGlob`): each with the paths it matches, absolute and realpath'd,
	 * or with `matches` undefined when this check cannot enumerate them. Each
	 * also escalates, and appears in `writes` as written where the command's
	 * branch records it. Read only by the edit-family rule check
	 * (lib/rules/matcher.ts `decide`), so a rule on `config/prod.yaml` sees
	 * `rm config/*.yaml`; containment never relies on the expansion.
	 */
	globWrites: { token: string; matches?: { absolute: string; resolved?: string }[] }[];
	/** Credential/secret paths named anywhere in the command (original tokens, never expanded). */
	sensitivePaths: string[];
	/** In-project paths whose contents execute later (`.git/hooks/*`, `.vscode/*.json`). */
	executionPrimitives: string[];
	/**
	 * Tooling/agent-configuration paths (`lib/rules/protected-paths.ts`: `.cargo/`,
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
	 * True when every reason this escalated is a read the classifier should
	 * see: an outside-cwd read, or a read that names a credential or an
	 * execution-primitive path (`find -name '*.pem'`, `cat Makefile`). No write,
	 * mutation, network, unknown command or unmodelled syntax, so nothing here
	 * can write a file. Never true for a "safe" verdict.
	 */
	readsOnly: boolean;
	/**
	 * True when the ONLY reason this escalated is Claude Code's acceptEdits file
	 * commands (`ACCEPT_EDITS_OPTIONS`) on the working space — every path is
	 * inside the working directory (or a `writableRoots` entry) and resolved,
	 * nothing touches the network, no credential/execution-primitive path, no
	 * unknown command, interpreter, glob, xargs, `cd`, or unmodelled syntax.
	 * Never true when the verdict is "safe" (nothing escalated) — it only
	 * qualifies an escalation.
	 */
	containedNonNetwork: boolean;
	/**
	 * True when every reason this escalated is a command this check knows
	 * nothing about: a program with no option table, no git or find branch and
	 * no product read-only entry (`gh`, `jq`-like tools it has never listed).
	 * No write, network, path, wrapper, assignment, substitution, `cd` or
	 * unmodelled syntax, and no known command that failed its table. A fact
	 * for plan mode, which lets a user's allow rule cover only such a line
	 * (lib/rules/matcher.ts `decide`); it never changes the verdict. Never true
	 * for a "safe" verdict.
	 */
	unlistedOnly: boolean;
	/**
	 * True when no command on the line reads a file: each one only filters its
	 * stdin (`head`, `grep pat`, `jq .`, `wc -l`: a `PIPE_FILTERS` command
	 * with no file operand, no option naming a file and no recursion) or takes
	 * no file at all (`NO_FILE_OPERANDS`), and no input redirect opens one. A
	 * fact independent of what is on disk, so it stays true however an earlier
	 * command on the line changed the filesystem; the read-only verdict does not
	 * (lib/rules/matcher.ts `findBashAllowRule`).
	 */
	readsNoFile: boolean;
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
export const NO_FILE_OPERANDS = new Set([
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
export const PATTERN_FIRST_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);

/**
 * Read-only commands that read their stdin when they name no file. With no
 * file operand and none of `PIPE_FILTER_FILE_OPTIONS`, one only filters what
 * it is piped (`readsNoFile`).
 */
const PIPE_FILTERS = new Set([
	"cat", "cksum", "column", "cut", "fold", "head", "jq", "md5sum", "nl", "od", "paste", "rev", "sha1sum", "sha256sum", "shasum", "sort", "tail",
	"uniq", "wc", "grep", "egrep", "fgrep", "rg",
]);

/** Options with which a `PIPE_FILTERS` command reads the working directory instead of its stdin (`grep -r pat`, `rg --files`). */
const PIPE_FILTER_FILE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	grep: ["-r", "--recursive", "-d", "--directories"],
	egrep: ["-r", "--recursive", "-d", "--directories"],
	fgrep: ["-r", "--recursive", "-d", "--directories"],
	rg: ["--files"],
};

interface WrapperSpec {
	/** Options whose next word is a harmless value, skipped in both readings. */
	values?: readonly string[];
	/**
	 * Options whose value changes where or how the payload runs (`env -C`,
	 * `time -o`, `script -T`). The strict reading leaves the value in command
	 * position, so the command escalates; the wide reading skips it.
	 */
	unsafeValues?: readonly string[];
	/** Options whose value is a command line of its own (`flock -c`, `env -S`, `su -c`): the wide reading returns it. */
	scripts?: readonly string[];
	/**
	 * The first operand is never the command: a file (`flock LOCK cmd`,
	 * `script LOG cmd`), a CPU mask (`taskset 0x3 cmd`) or a user (`su root
	 * -c '…'`). Options may follow it too.
	 */
	operandFirst?: boolean;
	/** The first operand is a value when it has this shape (`timeout 30 cmd`, `chrt 10 cmd`). */
	valueFirst?: RegExp;
	/** Wraps a compound command, after an optional name: `coproc { cmd; }`, `coproc NAME { cmd; }`. */
	compound?: boolean;
	/**
	 * Whether an in-project payload stays contained (`containedNonNetwork`).
	 * xargs takes its targets from stdin, and flock and script write the
	 * file they are given, which nothing write-checks.
	 */
	contained: boolean;
	/**
	 * Options that take no value and leave the payload and where it runs
	 * unchanged. A single-dash word listed whole (`-x86_64`, `-`) is one flag,
	 * never a cluster of letters.
	 */
	flags?: readonly string[];
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
const ENV: WrapperSpec = {
	values: ["-u", "--unset"],
	unsafeValues: ["-C", "--chdir"],
	scripts: ["-S", "--split-string"],
	flags: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
	contained: true,
};
const NICE: WrapperSpec = { values: ["-n", "--adjustment"], contained: true };
/** Every spelling `timeout` takes for its duration: `30`, `2.5m`, `+5`, `1e1`, `0x5`, `0x1p3`, `inf`. */
const TIMEOUT: WrapperSpec = {
	values: ["-s", "--signal", "-k", "--kill-after"],
	flags: ["-f", "--foreground", "--preserve-status", "-v", "--verbose", "-p"],
	valueFirst: /^\+?(inf(inity)?|0x[0-9a-f.]+(p[+-]?[0-9]+)?|[0-9.]+(e[+-]?[0-9]+)?)[smhd]?$/i,
	contained: true,
};

const WRAPPERS: Record<string, WrapperSpec> = {
	// macOS `arch -x86_64 cmd` runs cmd as that architecture; `-e NAME=value` sets its environment.
	arch: {
		values: ["-arch", "-d"],
		unsafeValues: ["-e"],
		flags: ["-32", "-64", "-i386", "-x86_64", "-x86_64h", "-arm64", "-arm64e", "-c", "-h"],
		contained: true,
		denyFormsOnly: true,
	},
	// `builtin cd x` runs the builtin `cd` (PR #12 review: it hid a `cd` from the worktree guard).
	builtin: { contained: true },
	// Runs its argument as the command of that name (`busybox rm x`).
	busybox: { contained: false, denyFormsOnly: true },
	caffeinate: { values: ["-t", "-w"], flags: ["-d", "-i", "-m", "-s", "-u"], contained: true, denyFormsOnly: true },
	// util-linux `chrt [policy] [priority] cmd`; the priority may be left out for some policies.
	chrt: {
		values: ["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"],
		flags: [
			"-a", "--all-tasks", "-b", "--batch", "-d", "--deadline", "-e", "--ext", "-f", "--fifo", "-i", "--idle", "-o", "--other", "-r", "--rr",
			"-R", "--reset-on-fork", "-p", "--pid", "-v", "--verbose", "-m", "--max",
		],
		valueFirst: /^\d+$/,
		contained: true,
		denyFormsOnly: true,
	},
	command: { flags: ["-p", "-v", "-V"], contained: true },
	// bash 4+: `coproc cmd`, `coproc { cmd; }`, `coproc NAME { cmd; }` run cmd beside the shell.
	coproc: { compound: true, contained: false, denyFormsOnly: true },
	doas: { values: ["-u", "-a"], unsafeValues: ["-C"], flags: ["-n", "-s", "-L"], contained: false, denyFormsOnly: true },
	exec: { values: ["-a"], contained: false, denyFormsOnly: true },
	env: ENV,
	flock: { values: ["-w", "--timeout", "-E", "--conflict-exit-code"], scripts: ["-c", "--command"], flags: ["-s", "-x", "-e", "-n", "-u", "-o", "--shared", "--exclusive", "--nonblock", "--nb", "--unlock", "--close", "--verbose"], operandFirst: true, contained: false },
	// Homebrew's coreutils names for env, nice and timeout.
	genv: { ...ENV, denyFormsOnly: true },
	gnice: { ...NICE, denyFormsOnly: true },
	gtimeout: { ...TIMEOUT, denyFormsOnly: true },
	ionice: { values: ["-c", "--class", "-n", "--classdata"], flags: ["-t", "--ignore"], contained: true },
	nice: NICE,
	nohup: { contained: true },
	script: {
		values: ["-t", "-E", "--echo", "-m", "--logging-format"],
		unsafeValues: ["-T", "--log-timing", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io"],
		scripts: ["-c", "--command"],
		operandFirst: true,
		contained: false,
	},
	setsid: { flags: ["-w", "--wait", "-f", "--fork", "-c", "--ctty"], contained: true },
	stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], contained: true },
	// `su [options] [-] [user [args]]`: the user's shell runs `-c`'s script; util-linux takes options after the user too.
	su: {
		values: ["-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"],
		unsafeValues: ["-s", "--shell"],
		scripts: ["-c", "--command", "--session-command"],
		flags: ["-", "-f", "--fast", "-l", "--login", "-m", "-p", "--preserve-environment", "-P", "--pty"],
		operandFirst: true,
		contained: false,
		denyFormsOnly: true,
	},
	sudo: {
		values: ["-u", "-g", "-h", "-p", "-r", "-t", "-U", "-T", "-a", "--user", "--group", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--auth-type"],
		unsafeValues: ["-C", "-D", "-R", "--close-from", "--chdir", "--chroot"],
		flags: ["-n", "-E", "-H", "-i", "-s", "-k", "-K", "-S", "-b", "-A", "-P", "-B", "--non-interactive", "--preserve-env", "--set-home", "--login", "--shell", "--stdin", "--background", "--askpass", "--reset-timestamp", "--preserve-groups", "--bell"],
		contained: false,
		denyFormsOnly: true,
	},
	// util-linux `taskset [options] mask cmd`; with `-p` the operand after the mask is a process id.
	taskset: { flags: ["-a", "--all-tasks", "-c", "--cpu-list", "-p", "--pid"], operandFirst: true, contained: true, denyFormsOnly: true },
	time: { values: ["-f", "--format"], unsafeValues: ["-o", "--output"], flags: ["-p", "-l", "-v", "--portability", "--verbose"], contained: true },
	timeout: TIMEOUT,
	watch: { values: ["-n", "--interval", "-q", "--equexit"], flags: ["-d", "-t", "-b", "-e", "-g", "-c", "-x", "-p", "-w", "--differences", "--no-title", "--beep", "--errexit", "--chgexit", "--color", "--exec", "--precise", "--no-wrap"], contained: false, denyFormsOnly: true },
	xargs: {
		values: ["-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "-E", "-d", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--eof"],
		unsafeValues: ["-a", "--arg-file"],
		flags: ["-0", "-r", "-t", "-p", "-x", "-o", "--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit", "--open-tty"],
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

/** Whether `name` (a command word, basename, lowercased) is one of the filesystem-mutating commands above. */
export function isMutationCommand(name: string): boolean {
	return MUTATION_COMMANDS.has(name);
}

/**
 * Whether this check knows the command `name` (a basename, lowercased): it has
 * an option table, a git or find branch or a product read-only entry for it,
 * or lists it as mutating, network-capable or a script interpreter. The
 * PowerShell side of `unlistedOnly`: a native program the bash check knows is
 * one plan mode will not let an allow rule cover unexamined.
 */
export function gateKnowsCommand(name: string): boolean {
	return (
		READ_ONLY_COMMANDS.has(name) ||
		name === "git" ||
		name === "find" ||
		name === "cd" ||
		MUTATION_COMMANDS.has(name) ||
		NETWORK_COMMANDS.has(name) ||
		SCRIPT_INTERPRETERS.has(name) ||
		productReadOnlySubcommands(name) !== undefined
	);
}

/**
 * Whether the line writes by what this check saw: a write target it recorded
 * (a redirect, a mutating command's operand, `sort -o`), or a mutating command
 * whose targets it could not list (`rm *`). Plan mode refuses such a line
 * outright (lib/rules/matcher.ts `decide`); a line this misses is one the
 * pre-gate could not prove read-only either, which plan mode puts to the user.
 */
export function namesWrite(evidence: ShellEvidence): boolean {
	return evidence.writes.length > 0 || evidence.commands.some(isMutationCommand);
}

/** The delete/truncate commands whose targets are every positional, bare names included. */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "shred", "truncate"]);

/**
 * Claude Code's acceptEdits file commands (2.1.282, findings §36), with the
 * options this check models; the only mutations that can be marked contained.
 * Any other option, one carrying a value included (`cp -t dir`,
 * `--target-directory=dir`, `mkdir -m`), leaves the command uncontained, as do
 * symlink-following `cp -L`/`-H`. `sed` is on Claude Code's list but left out
 * until its program is checked the way Claude Code checks it; Claude Code
 * classified `sed -i '' …` anyway. This is an *allowlist* for the "provably
 * contained" conclusion: omission only sends a command to the classifier.
 */
const ACCEPT_EDITS_OPTIONS: Record<string, OptionSpec> = {
	rm: table({ none: "-f -R -r -i -v -I -d --force --recursive --verbose --dir --interactive" }),
	rmdir: table({ none: "-p -v --parents --verbose" }),
	mkdir: table({ none: "-p -v --parents --verbose" }),
	touch: table({ none: "-a -c -m --no-create" }),
	cp: table({ none: "-r -R -f -i -n -p -v -a -P --recursive --force --interactive --no-clobber --verbose --archive --no-dereference" }),
	mv: table({ none: "-f -i -n -v --force --interactive --no-clobber --verbose" }),
};

/**
 * The operands of an acceptEdits file command, or undefined when it carries an
 * option `ACCEPT_EDITS_OPTIONS` does not model. After `--` every word is an operand.
 */
function acceptEditsOperands(name: string, args: Token[]): Token[] | undefined {
	const spec = ACCEPT_EDITS_OPTIONS[name];
	if (!spec) return undefined;
	const check = checkOptions(spec, args);
	return check.ok ? check.parsed.positionals : undefined;
}

/** Whether the file at `path` (written `word`) is a symbolic link, or a directory or glob that may hold one. */
function mayCarryLink(path: string, word: string): boolean {
	if (hasGlob(word)) return true;
	try {
		const stat = lstatSync(path);
		return stat.isSymbolicLink() || stat.isDirectory();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * A write target: a word as the tokenizer read it, which knows whether bash
 * expands it, or a bare string (a redirect target, a path built from words),
 * judged by its text.
 */
type WriteWord = string | Token;

/**
 * Whether bash expands `word` as a glob. The tokenizer knows for a plain word
 * (`'*'` and `\*` are literal, `config/*'.yaml'` globs). A bare string, a word
 * with an expansion in it (its value is source text) and one with a brace
 * (the tokenizer leaves `{a,b}` unexpanded) are judged by their text.
 */
function expandsAsGlob(word: WriteWord): boolean {
	const text = typeof word === "string" ? word : word.value;
	return typeof word === "string" || word.dynamic || text.includes("{") ? /[*?[]/.test(text) : !!word.glob;
}

/** Glob/other shell metacharacters we cannot enumerate, so a target carrying one is not "concrete". */
function hasGlob(token: string): boolean {
	return /[*?\[\]]/.test(token);
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
	/**
	 * Words skipped after a wrapper without knowing what they do: an option its
	 * spec does not list (`env -a`, `env --chd=/tmp`) and an assignment that is
	 * not inert (`env PATH=./bin`). The payload named may not be what runs, or
	 * not where, so the pre-gate proves nothing about such a line.
	 */
	opaque: string[];
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
	const payload: Payload = { command: "", args: [], peeled: [], pathNamed: [], scripts: [], opaque: [] };
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
			// A single-dash word the spec lists whole is one option (`arch -arm64e`,
			// `arch -arch x86_64`), never letters that might name another (`-e`).
			if (spec.flags?.includes(word)) {
				index++;
				continue;
			}
			if (kind(spec, word)) {
				option = word;
			} else if (word.startsWith("--")) {
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
			// `nice -10` is an adjustment; any other unlisted option is unknown.
			if (type === undefined && !knownFlags(spec, word) && !/^-\d+$/.test(word)) payload.opaque.push(word);
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
		for (; index < tokens.length; index++) {
			const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(tokens[index].value);
			if (!assigned) break;
			// Before the first word the caller judges it; after a wrapper (`env NAME=value cmd`) nothing else does.
			if (payload.peeled.length > 0 && !isInertAssignment(tokens[index].value)) payload.opaque.push(tokens[index].value);
		}
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
		if (spec.operandFirst && index < tokens.length) {
			index++;
			// `flock LOCK -c '…'`, `su root -c '…'`: options may follow the operand too.
			skipOptions(spec);
		}
		if (spec.valueFirst && index < tokens.length && spec.valueFirst.test(tokens[index].value)) index++;
		// `coproc { cmd; }` and `coproc NAME { cmd; }`: the group's first command is the payload.
		if (spec.compound) {
			if (tokens[index]?.value === "{") index++;
			else if (tokens[index + 1]?.value === "{") index += 2;
		}
	}
}

/** Whether `word` is made only of the wrapper's listed flags (`-i`, `--null`, or a cluster such as `-iv`). */
function knownFlags(spec: WrapperSpec, word: string): boolean {
	const flags = spec.flags ?? [];
	if (word.startsWith("--")) return flags.includes(word);
	return word.length > 1 && [...word.slice(1)].every((letter) => flags.includes(`-${letter}`));
}

/** Whether every peeled wrapper keeps an in-project payload contained (see `WrapperSpec.contained`). */
function wrappersContained(peeled: readonly string[]): boolean {
	return peeled.every((name) => WRAPPERS[name]?.contained);
}

/** Shells whose `-c` argument is a command line of its own. */
export const INLINE_SCRIPT_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Shell options that take the next word as their value. */
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/**
 * The command lines a shell invocation's `-c` runs, given the shell's
 * arguments, or undefined when it has no `-c` (alone or in a cluster such as
 * `-lc` or `-ce`, anywhere among the leading options, whose values are
 * skipped: `bash -c -o pipefail 'x'` runs `x`). The script is the first
 * operand; the words after it are `$0`, `$1`, … (`bash -c 'echo ok' 'git
 * status'` runs no git), unless the script expands them (`bash -c '"$@"' _
 * git status`), when they are a command line too. The one reader of `-c` for
 * the deny forms and the worktree guard.
 */
export function inlineShellScripts(args: readonly string[], reading: "strict" | "wide" = "strict"): string[] | undefined {
	const cluster = (value: string) => /^-[A-Za-z]+$/.test(value) && value.includes("c");
	let command = false;
	let i = 0;
	for (; i < args.length; i++) {
		const value = args[i];
		if (value === "--" || value === "-") {
			i++;
			break;
		}
		if (!/^[-+]/.test(value)) break;
		if (cluster(value)) command = true;
		// `-o`/`-O` take the next word, last in a cluster too: `-euo pipefail`.
		if (SHELL_VALUE_OPTIONS.has(value) || /^[-+][A-Za-z]*[oO]$/.test(value)) i++;
	}
	if (!command) {
		// The wide reading (deny forms, which may only widen) also takes a `-c`
		// past the first operand, which bash hands to the script it names.
		const late = reading === "wide" ? args.findIndex(cluster) : -1;
		if (late < 0) return undefined;
		i = late + 1;
	}
	const [script, ...positional] = args.slice(i);
	if (script === undefined) return [];
	// `$0`…`$9`, `$@`, `$*`, `${1}`, `${@}`: read both from `$0` and from `$1`.
	if (!/\$(?:[0-9@*]|\{[0-9@*])/.test(script) || positional.length === 0) return [script];
	return [script, positional.join(" "), positional.slice(1).join(" ")];
}

/** Commands that change the shell's working directory. */
export const DIRECTORY_MOVERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** Whether a segment's command (past `time` and wrappers) changes the shell's directory. */
export function movesDirectory(seg: Segment): boolean {
	return DIRECTORY_MOVERS.has(resolvePayload(leadTokens(seg)).command);
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

/**
 * A command word's program name: its basename, lowercased, without a Windows
 * executable extension (`.exe`, `.cmd`, `.bat`, `.com`). Plan mode's runner
 * check and the PowerShell tree read it; the bash gate's own `commandName`
 * below strips `.exe` only.
 */
export function programName(word: string): string {
	return (word.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
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

/** Whether a `NAME=value` word sets an inert variable to a value that keeps it inert. */
function isInertAssignment(word: string): boolean {
	const eq = word.indexOf("=");
	const name = word.slice(0, eq);
	return INERT_ASSIGNMENTS.test(name) && isInertValue(name, word.slice(eq + 1));
}

/**
 * A `~` word other than `~` and `~/…`: bash expands `~name` to that user's
 * home and `~-`/`~+` to `$OLDPWD`/`$PWD`, which `toAbsolute` would read as a
 * directory literally named `~name` inside the working directory.
 */
export function isUnknownTilde(value: string): boolean {
	return value.startsWith("~") && value !== "~" && !value.startsWith("~/");
}

/**
 * The paths a shell write must never land on, or take with it when it
 * removes or moves a directory: protected tooling and agent configuration,
 * the harness's `protectedDirs`, and credential and execution-primitive
 * paths. Shared by the bash gate and the PowerShell gate (powershell-tree.ts).
 */
export function isGuardedWritePath(path: string, cwd: string, protectedDirs: readonly string[] = []): boolean {
	return isProtectedPath(path, cwd) || protectedDirs.some((dir) => isWithin(dir, path)) || isSensitivePath(path) || isExecutionPrimitivePath(path);
}

/**
 * Whether removing or moving away `resolved` (spelled `absolute`) loses what
 * git or the gate would keep: a working root, a `.git`, a directory holding
 * one at any depth, or a guarded path or a directory holding one (`rm -rf .`,
 * `mv .git x`, `rm -rf vendor` over `vendor/lib/.git`, `rm -rf .claude`).
 */
export function removalLoses(absolute: string, resolved: string, roots: readonly string[], cwd: string, protectedDirs: readonly string[] = []): boolean {
	const lost = (path: string) => path.split(/[\\/]/).includes(".git") || isGuardedWritePath(path, cwd, protectedDirs);
	return roots.includes(resolved) || lost(absolute) || lost(resolved) || touchesGuardedPath(resolved, resolved, lost);
}

/** The last component of a bash path word, trailing slashes dropped (`a/b/` is `b`). */
function bashBasename(word: string): string {
	const trimmed = word.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Where `source` lands when moved or copied into the directory `dir`: `dir/<basename>`, a glob if either word is one. */
function landingBeneath(dir: Token, source: Token): Token {
	return { value: `${dir.value.replace(/\/+$/, "")}/${bashBasename(source.value)}`, glob: dir.glob || source.glob || undefined, dynamic: dir.dynamic ?? source.dynamic };
}

/** The short options that take a value, for the commands with a `-t DIR` option: in a cluster, the letters after one are its value (`-St` is suffix `t`). */
const TARGET_DIRECTORY_COMMANDS: Record<string, string> = { mv: "St", cp: "St", ln: "St", install: "Stmog" };

/**
 * The directory `mv`, `cp`, `ln` or `install` puts its operands in, and those
 * operands: `-t DIR`, `-tDIR` (also ending a cluster, `-ft DIR`),
 * `--target-directory=DIR` or `--target-directory DIR`, with GNU's
 * abbreviations of the long form (`--target=DIR`). `dir` is undefined when no
 * such option is given. After `--` every word is an operand. A long option's
 * separate value this does not model (`--suffix X`) counts as an operand,
 * which only adds a write target.
 */
function targetDirectoryOperands(name: string, args: readonly Token[]): { dir?: string; operands: string[] } {
	const valued = TARGET_DIRECTORY_COMMANDS[name] ?? "";
	let dir: string | undefined;
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const value = args[i].value;
		if (value === "--") {
			operands.push(...args.slice(i + 1).map((token) => token.value));
			break;
		}
		if (value.startsWith("--")) {
			const equals = value.indexOf("=");
			const option = equals < 0 ? value : value.slice(0, equals);
			if (option.length > 2 && "--target-directory".startsWith(option)) dir = equals < 0 ? args[++i]?.value : value.slice(equals + 1);
			continue;
		}
		if (value.startsWith("-") && value.length > 1) {
			for (let j = 1; j < value.length; j++) {
				if (!valued.includes(value[j])) continue;
				const optionValue = value.slice(j + 1) || args[++i]?.value;
				if (value[j] === "t") dir = optionValue;
				break;
			}
			continue;
		}
		operands.push(value);
	}
	return { dir: dir || undefined, operands };
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
function gitEscalationReason(
	args: Token[],
	dirOutsideCwd: (dir: string, from?: string) => { outside: boolean; at: string },
	onFileReads: (words: Token[]) => void,
	repositoryAbove: (from?: string) => boolean,
): string | undefined {
	let index = 0;
	/** Where git stands after the `-C` options read so far: git applies each one from the one before. */
	let chained: string | undefined;
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
			const judged = dir ? dirOutsideCwd(dir, chained) : undefined;
			if (!judged || judged.outside) return `runs git -C ${dir ?? ""}, which points outside the working directory`;
			chained = judged.at;
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
		if ((flag === "--git-dir" || flag === "--work-tree") && value !== undefined && dirOutsideCwd(value).outside) {
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
	// From a subdirectory of a larger repository, `git grep --untracked` with a
	// top-level pathspec (`:/`, `../..`) prints files above the working
	// directory that no commit holds, an ignored `.env` at the root included.
	// (The committed ones any history read prints anyway: `git log -p`.)
	if (subcommand === "grep" && check.parsed.seen.has("--untracked") && repositoryAbove(chained)) {
		return "runs git grep --untracked in a repository whose root is above the working directory, where a pathspec can read untracked files above it";
	}
	return undefined;
}

/**
 * One `-C <word>` step of the directory chain git walks: `word` applied from
 * the real directory `from` lands on, then resolved through symbolic links.
 * git changes into each directory in turn, so a later `-C ..` climbs from
 * where a link pointed, not from the link's own parent: with `deep/link`
 * pointing at the working directory, `git -C deep/link -C .. status` runs
 * one level above it. `resolved` is the containment form, undefined when
 * nothing of the path resolves (`at` is then the lexical path).
 *
 * The word itself is walked in filesystem order too: the kernel follows a
 * link before it applies the `..` after it, so `-C deep/link/..` is the
 * parent of where the link points, not `deep`. Each run of names between
 * `..` segments is resolved before the climb.
 */
function gitDirectoryStep(from: string, word: string, home: string): { at: string; resolved: string | undefined } {
	let at = resolveThroughLinks(from) ?? from;
	/** Change into a run of names (the part of the word between two `..`), resolving where it lands. */
	const land = (names: string) => {
		if (names === "" || names === ".") return;
		const lexical = toAbsoluteBash(at, names, home);
		at = resolveThroughLinks(lexical) ?? lexical;
	};
	// A word that starts at the root keeps its leading slash on the first run.
	const runs = word.split(/(?:^|\/)\.\.(?=\/|$)/);
	runs.forEach((run, index) => {
		if (index > 0) at = dirname(at);
		land(index === 0 ? (run === "" && word.startsWith("/") ? "/" : run) : run.replace(/^\/+/, ""));
	});
	return { at, resolved: resolveForContainment(at) };
}

/** The directory git runs in: `cwd`, then each leading `-C <dir>` in turn, as git applies them ({@link gitDirectoryStep}). */
function gitWorkingDirectory(args: Token[], cwd: string, home: string): string {
	let dir = cwd;
	for (let index = 0; index < args.length; ) {
		const token = args[index].value;
		if (token === "-C") {
			const next = args[index + 1]?.value;
			if (next) dir = gitDirectoryStep(dir, next, home).at;
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
function gitCheckoutReason(args: Token[], cwd: string, home: string, seen: Map<string, CheckoutProgram | undefined>, hooks: readonly string[] = READ_HOOKS): string | undefined {
	// Only `-C` and the safe global options lead a command that reaches this check.
	const dir = gitWorkingDirectory(args, cwd, home);
	// Memoized for one analysis only: nothing runs between its segments, but the
	// model can rewrite `.git/config` between calls.
	const key = `${hooks.join(",")}\0${dir}`;
	if (!seen.has(key)) seen.set(key, checkoutGitRunsProgram(dir, home, hooks));
	const why = seen.get(key);
	return why && `runs git in a checkout that can run a program (${why.kind}${"key" in why && why.key ? `: ${why.key}` : "hook" in why ? `: ${why.hook}` : ""})`;
}

export interface AnalyzeInput {
	command: string;
	cwd: string;
	home: string;
	/**
	 * Directories protected at runtime beyond protected-paths.ts's static list
	 * (pi's own agent dir — lib/rules/matcher.ts `DecideInput.protectedDirs`).
	 * A redirect landing inside one escalates like a write to `.git/hooks`.
	 */
	protectedDirs?: string[];
	/**
	 * REALPATH-resolved directories a read-only command may read from besides
	 * the working directory without escalating: the harness's own session dirs
	 * (memory, scratchpad, persisted results, this project's transcripts —
	 * lib/rules/matcher.ts `DecideInput.sessionDirPath`), resolved once per
	 * session by the caller (compared against realpaths here, unresolved). Reads
	 * only; the write and delete checks never consult this list.
	 */
	readableRoots?: string[];
	/**
	 * REALPATH-resolved directories a write may land in besides the working
	 * directory without leaving the working space: the workspace directories,
	 * passed only for a model that gets Claude Code's fast paths
	 * (lib/rules/matcher.ts `DecideInput.claudeCodeFastPaths`).
	 */
	writableRoots?: string[];
}

/**
 * Whether this simple command's words have the pre-gate's read-only proof.
 * Reuse the entire analyzer, including option/operand rules and git's checkout
 * checks, rather than treating a command name as a proof. No expansions,
 * nested commands or stdin scripts are exempted by this narrower predicate.
 * Redirects are NOT exempted: callers must still scan them independently.
 * Pure apart from the analyzer's existing filesystem reads.
 */
export function hasReadOnlyShellWords(segment: Segment, cwd: string, home: string): boolean {
	if (segment.substitution !== undefined || segment.stdin?.length || segment.tokens.some((word) => word.dynamic || word.glob)) return false;
	const { command, peeled, pathNamed } = resolvePayload(segment.tokens);
	if (peeled.length || pathNamed.length || !(READ_ONLY_COMMANDS.has(command) || command === "git" || command === "find")) return false;
	const evidence = analyzeShellCommand({ command: segment.raw, cwd, home });
	return evidence.commands.length === 1 && evidence.writes.length === 0 && (evidence.verdict === "safe" || evidence.readsOnly);
}

/**
 * Classify a shell command. Never denies — see the module contract above.
 */
export function analyzeShellCommand({ command, cwd, home, protectedDirs = [], readableRoots = [], writableRoots = [] }: AnalyzeInput): ShellEvidence {
	const checkoutReasons = new Map<string, CheckoutProgram | undefined>();
	const evidence: ShellEvidence = {
		verdict: "safe",
		notes: [],
		commands: [],
		writes: [],
		globWrites: [],
		sensitivePaths: [],
		executionPrimitives: [],
		protectedPaths: [],
		network: [],
		outsideReads: [],
		readOnlyOutside: false,
		readsOnly: false,
		containedNonNetwork: false,
		unlistedOnly: false,
		readsNoFile: false,
	};
	/** Cleared by any word read-checked and by any command that is not a pipe filter given no file (see readsNoFile). */
	let readsNoFile = true;
	/**
	 * Set by any escalation reason that is NOT a bare in-project mutation — i.e.
	 * anything meaning the command reaches outside the project or cannot be fully
	 * accounted for. When it stays false through an escalation, the only blocker
	 * was in-project mutation (`containedNonNetwork`).
	 */
	let uncontained = false;
	/** The segments whose contained `mv` or `cp` may move a symbolic link. */
	const relocating = new Set<Segment>();
	/** Set by any escalation that is not an outside-cwd read (see readOnlyOutside). */
	let escalatedBeyondReads = false;
	/** Set by any escalation that is neither an outside-cwd read nor a read naming a guarded path (see readsOnly). */
	let escalatedBeyondNamedReads = false;
	/** Set by any escalation that is not a command this check knows nothing about (see unlistedOnly). */
	let escalatedBeyondUnlisted = false;
	const escalate = (note: string, opts?: { contained?: boolean; outsideRead?: boolean; namedRead?: boolean; unlisted?: boolean }) => {
		evidence.verdict = "escalate";
		if (!opts?.unlisted) escalatedBeyondUnlisted = true;
		if (!opts?.contained) uncontained = true;
		if (!opts?.outsideRead) escalatedBeyondReads = true;
		if (!opts?.outsideRead && !opts?.namedRead) escalatedBeyondNamedReads = true;
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

	/** Record a removing or moving command's glob operand with what it expands to here (`ShellEvidence.globWrites`). */
	const recordGlobWrite = (token: string) => {
		const words = isUnknownTilde(token) ? undefined : expandGlob(effectiveCwd, token, home);
		evidence.globWrites.push({
			token,
			matches: words?.map((word) => {
				const absolute = toAbsoluteBash(effectiveCwd, word, home);
				return { absolute, resolved: resolveForContainment(absolute) };
			}),
		});
	};

	/**
	 * Resolve a write-target token, record it as evidence, and escalate on any
	 * target that cannot be resolved, escapes the working directory, or names a
	 * credential / execution-primitive path. Shared by redirections, mutating
	 * command positionals, and output-flag targets so all writes get one check.
	 * `removes` marks an operand of a removing or moving command, whose glob is
	 * also expanded for the edit-family rule check (`recordGlobWrite`).
	 * Whether bash expands the word as a glob is {@link expandsAsGlob}.
	 */
	const checkWriteTarget = (word: WriteWord, removes = false) => {
		const token = typeof word === "string" ? word : word.value;
		if (token === "/dev/null") return;
		const globCharacters = /[*?[]/.test(token);
		const expands = expandsAsGlob(word);
		// A `~name`/`~-` target or a glob lands wherever bash expands it, which
		// this check cannot know (SECURITY-REVIEW-2026-09-23 M2).
		if (isUnknownTilde(token) || expands) {
			if (removes && expands) recordGlobWrite(token);
			evidence.writes.push({ token, absolute: token, outsideCwd: true });
			escalate(`writes to ${token}, which bash expands to a path this check cannot resolve`);
			return;
		}
		// A quoted `'config/*.yaml'` is one literal file name: it is resolved and
		// recorded like any other target, so a rule naming that exact file sees
		// it and a rule on a file the pattern would match does not. It still
		// escalates, as every name with glob characters did before.
		if (globCharacters) escalate(`writes to ${token}, a quoted file name with glob characters`);
		const absolute = toAbsoluteBash(effectiveCwd, token, home);
		const resolved = resolveForContainment(absolute);
		const outsideCwd = resolved === undefined || !(isWithin(containmentRoot, resolved) || writableRoots.some((root) => isWithin(root, resolved)));
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
		readsNoFile = false;
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
				escalate(`reads ${value}, which resolves to a credential or secret path`, { namedRead: true });
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
				escalate(`reads ${word.value} on stdin, which is a credential or secret path`, { namedRead: true });
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
			if (!isInertAssignment(token.value)) escalate(`sets ${assigned}, which can change what the command runs or reads`);
		}

		const { command: name, args, peeled, pathNamed, opaque } = resolvePayload(segment.tokens);
		for (const word of opaque) escalate(`passes ${word} to ${peeled.join(" → ")}, which can change what runs or where`);
		if (!PIPE_FILTERS.has(name) && !NO_FILE_OPERANDS.has(name)) readsNoFile = false;
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
				escalate(`names ${value}, which is a credential or secret path`, { namedRead: true });
			}
			if (isExecutionPrimitivePath(absolute)) {
				if (!evidence.executionPrimitives.includes(value)) evidence.executionPrimitives.push(value);
				escalate(`touches ${value}, whose contents execute later without further approval`, { namedRead: true });
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

		// Bash expands a glob before the command parses its options, so a match
		// that starts with `-` arrives as an option no table judged: with a file
		// named `--output=victim`, `sort *` writes `victim`
		// (AUTO-MODE-SECURITY-REVIEW-2026-09-24 H4). A glob this check cannot
		// enumerate escalates when its expansion could start with `-`.
		for (const token of args) {
			if (!token.glob) continue;
			const matches = expandGlob(effectiveCwd, token.value, home);
			const injects = matches === undefined ? /^[-*?[]/.test(token.value) : matches.some((match) => match !== token.value && match.startsWith("-"));
			if (injects) {
				escalate(`passes the glob ${token.value}, which can expand to a filename starting with -, read as an option`);
				break;
			}
		}

		if (name === "git") {
			const fileReads: Token[] = [];
			const reason =
				gitEscalationReason(
					args,
					(dir, from) => {
						const { at, resolved } = gitDirectoryStep(from ?? effectiveCwd, dir, home);
						if (isUnknownTilde(dir)) return { outside: true, at };
						return { outside: resolved === undefined || !isWithin(containmentRoot, resolved), at };
					},
					(words) => fileReads.push(...words),
					(from) => {
						const dir = resolveForContainment(from ?? effectiveCwd);
						const root = dir === undefined ? undefined : findGitRoot(dir);
						return dir === undefined || (root !== undefined && !isWithin(containmentRoot, root));
					},
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
		// Claude Code's acceptEdits file commands with modelled options are the
		// contained mutations, their targets checked below; any other mutation
		// (tar/dd/ln/…) stays uncontained.
		const fileOperands = acceptEditsOperands(name, args);
		if (isMutation) escalate(`runs ${name}, which modifies the filesystem`, { contained: fileOperands !== undefined });
		// A source that is a symbolic link, or a directory or glob that may hold one, carries the link to its new place.
		if (fileOperands !== undefined && (name === "mv" || name === "cp") && fileOperands.slice(0, -1).some((source) => mayCarryLink(toAbsoluteBash(effectiveCwd, source.value, home), source.value))) {
			relocating.add(segment);
		}


		// A read-only command is proved read-only by its options, not its name:
		// each option must be in the command's table (read-only-options.ts), so
		// `rg --pre=<prog>`, `tree -o f` and `uniq in out` escalate
		// (SECURITY-REVIEW-2026-09-23 H1). Its operands, and the files named by
		// options such as `grep -f`, are then read-checked.
		const productSubcommands = productReadOnlySubcommands(name);
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
				// A glob where the pattern, program or format goes becomes that operand
				// only in its first match; the rest are operands this check never saw
				// (`grep *` reads every match but the first, jq's program is a filename).
				const lead = operands[0];
				if (lead?.glob && (patternFirst || spec.programFirst || spec.operandReason)) {
					escalate(`runs ${name} with the glob ${lead.value} as its first operand, which ${name} does not read as a file, so the other matches go unchecked`);
				}
				if (patternFirst || spec.programFirst) operands.shift();
				const reads = NO_FILE_OPERANDS.has(name) ? check.parsed.fileValues : [...operands, ...check.parsed.fileValues];
				for (const word of reads) checkRead(word);
				if (PIPE_FILTER_FILE_OPTIONS[name]?.some((option) => check.parsed.seen.has(option))) readsNoFile = false;
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
		} else if (!isMutation && productSubcommands) {
			// A product's own read-only subcommand (lib/shell/product-read-only.ts):
			// the subcommand must be the first word, written out, and every option
			// in its table. Its operands are names, not files, so none is read-checked.
			const [subcommand, ...rest] = args;
			const spec = subcommand && !subcommand.glob && !subcommand.dynamic ? productSubcommands.get(subcommand.value) : undefined;
			if (!spec) {
				escalate(`runs ${name}${subcommand ? ` ${subcommand.value}` : ""}, which is not on the read-only allowlist`);
			} else {
				const check = checkOptions(spec, rest);
				if (!check.ok) escalate(`runs ${name} ${subcommand.value} and ${check.reason}`);
				else if (!rest.every((word) => !word.dynamic && isNameOperand(word.value))) escalate(`runs ${name} ${subcommand.value} with an argument that is not a short name, and the command may send it over the network`);
			}
		} else if (!isMutation) {
			escalate(`runs ${name}, which is not on the read-only allowlist`, { unlisted: true });
		}

		// The positional destinations of writing commands are the paths that get
		// written. (Redirections were already handled at the top of the loop.)
		const writeTokens: WriteWord[] = [];
		if (fileOperands !== undefined) {
			// Every operand is a path, bare names included. cp and mv write their
			// last operand and read the rest (mv removes them as well, below), so a
			// source outside the working space (or a credential) is an outside read
			// and leaves the line uncontained.
			const copies = name === "cp" || name === "mv";
			const reads = copies ? fileOperands.slice(0, -1) : [];
			// The paths the write checks guard, beneath a directory operand as well
			// as at it: they protect the files, not the directory holding them.
			const guarded = (path: string) => isGuardedWritePath(path, effectiveCwd, protectedDirs);
			// Removing or moving away a working root, a `.git`, or a guarded path,
			// or a directory holding one, is never contained (`removalLoses`).
			for (const token of name === "mv" ? reads : name === "rm" || name === "rmdir" ? fileOperands : []) {
				const absolute = toAbsoluteBash(effectiveCwd, token.value, home);
				const resolved = resolveForContainment(absolute);
				if (resolved === undefined) continue;
				if (removalLoses(absolute, resolved, [containmentRoot, ...writableRoots], effectiveCwd, protectedDirs)) {
					escalate(`${name === "mv" ? "moves" : "removes"} ${token.value}, which is a working root, or is or holds a git repository or a protected, credential or execution-primitive path`);
				}
			}
			for (const token of reads) {
				if (isSensitivePath(toAbsoluteBash(effectiveCwd, token.value, home))) {
					if (!evidence.sensitivePaths.includes(token.value)) evidence.sensitivePaths.push(token.value);
					escalate(`copies or moves ${token.value}, a credential or secret path`);
				}
				checkRead(token);
			}
			// A move removes its sources, so each is a write target too: a deny
			// rule on `config/prod.yaml` must see `mv config/prod.yaml old.yaml`.
			if (name === "mv") writeTokens.push(...reads);
			const destination = copies ? fileOperands.at(-1) : undefined;
			if (destination === undefined) {
				writeTokens.push(...fileOperands);
			} else if (reads.length === 0) {
				writeTokens.push(destination);
			} else {
				// Into an existing directory, each source lands beneath it (`cp
				// settings.json .claude` writes `.claude/settings.json`), and a
				// directory source brings its whole tree along.
				const intoDirectory = destination.value.endsWith("/") || isDirectory(toAbsoluteBash(effectiveCwd, destination.value, home));
				for (const source of reads) {
					const landing = intoDirectory ? landingBeneath(destination, source) : destination;
					writeTokens.push(landing);
					const target = landing.value;
					const sourceResolved = resolveForContainment(toAbsoluteBash(effectiveCwd, source.value, home));
					if (sourceResolved !== undefined && touchesGuardedPath(sourceResolved, toAbsoluteBash(effectiveCwd, target, home), guarded)) {
						escalate(`${name === "cp" ? "copies" : "moves"} ${source.value} to ${target}, which puts files on a protected, credential or execution-primitive path`);
					}
				}
			}
		} else if (isDelete) {
			// A delete's targets are every non-flag positional, bare names included
			// (`rm notes.txt` has no slash but is still a real target that
			// must be resolved). A glob target cannot be enumerated, so
			// it drops out of containment — the command then reaches the classifier.
			for (const token of args) {
				if (token.value.startsWith("-")) continue;
				if (expandsAsGlob(token)) {
					escalate(`targets ${token.value}, a glob whose expansion cannot be checked`);
					recordGlobWrite(token.value);
					continue;
				}
				writeTokens.push(token);
			}
		} else if (isMutation) {
			const positionals = args.filter((token) => !token.value.startsWith("-") && looksLikePath(token.value));
			// For cp/rsync/ln the destination is last; for the rest every
			// positional is a candidate target. A move with options this check
			// does not model writes every operand it names, its sources (which it
			// removes) and `-t`'s directory included, bare names too. With a
			// target directory (`-t DIR`, `--target-directory=DIR`), mv, cp, ln and
			// install write each operand's name beneath it, as they do when the last
			// operand is an existing directory or ends with a slash.
			const into = name in TARGET_DIRECTORY_COMMANDS ? targetDirectoryOperands(name, args) : undefined;
			// After `--` every word is an operand, a name that starts with a dash included.
			const delimiter = args.findIndex((token) => token.value === "--");
			const operands = delimiter < 0 ? args.filter((token) => !token.value.startsWith("-")) : [...args.slice(0, delimiter).filter((token) => !token.value.startsWith("-")), ...args.slice(delimiter + 1)];
			if (name === "mv") {
				writeTokens.push(...operands);
			} else if (into?.dir === undefined && ["cp", "rsync", "ln", "install"].includes(name)) {
				// The destination is the last operand even when it is a bare name
				// (`cp --sparse=always x prod.yaml`); rsync's may be a remote spec, so it keeps the path test.
				const last = (name === "rsync" ? positionals : operands).at(-1);
				if (last) writeTokens.push(last.value);
				// `ln -s ../prod.yaml` makes `prod.yaml` here.
				if (name === "ln" && operands.length === 1) writeTokens.push(bashBasename(operands[0].value));
			} else if (into?.dir === undefined) {
				writeTokens.push(...positionals.map((token) => token.value));
			}
			if (into !== undefined && into.dir === undefined && operands.length > 1) {
				// `mv --backup=numbered notes.md archive/` writes `archive/notes.md`.
				const destination = operands[operands.length - 1];
				if (destination.value.endsWith("/") || isDirectory(toAbsoluteBash(effectiveCwd, destination.value, home))) {
					for (const source of operands.slice(0, -1)) writeTokens.push(landingBeneath(destination, source));
				}
			}
			if (into?.dir !== undefined) {
				const dir = into.dir;
				if (!writeTokens.includes(dir)) writeTokens.push(dir);
				for (const operand of into.operands) writeTokens.push(`${dir.replace(/\/+$/, "")}/${bashBasename(operand)}`);
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

		const removes = isDelete || name === "mv";
		for (const token of writeTokens) checkWriteTarget(token, removes);
	}

	// A moved or copied relative symlink points somewhere else afterwards, and
	// every path on the line was judged on the files as they were before it
	// ran: `mv sub/rel link && echo x > link` writes where `sub/rel` pointed
	// from its new place. So a line that moves what may be a link is contained
	// only when the move is all it does. A source that does not exist yet was
	// made earlier on the line by a command judged here, and is no link.
	// Two such moves retarget each other the same way, so neither exempts the other.
	if (relocating.size > 1 || (relocating.size > 0 && segments.some((segment) => !relocating.has(segment) && (segment.redirects.length > 0 || segment.inputs.length > 0 || segment.tokens.length > 1)))) {
		escalate("moves or copies a file and names another path on the same line, which the move can retarget");
	}
	if ([...relocating].some((segment) => segment.redirects.length > 0)) {
		escalate("moves or copies a file and redirects on the same line, which the move can retarget");
	}

	// The command escalated, but every reason was an acceptEdits file command on
	// the working space: nothing reached outside it, the network, or the unknown.
	evidence.containedNonNetwork = evidence.verdict === "escalate" && !uncontained;
	evidence.readOnlyOutside = evidence.verdict === "escalate" && !escalatedBeyondReads;
	evidence.readsOnly = evidence.verdict === "escalate" && !escalatedBeyondNamedReads;
	evidence.unlistedOnly = evidence.verdict === "escalate" && !escalatedBeyondUnlisted;
	evidence.readsNoFile = readsNoFile && evidence.commands.length > 0;

	return evidence;
}
