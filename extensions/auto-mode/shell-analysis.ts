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

import { isExecutionPrimitivePath, isSensitivePath } from "./sensitive.ts";
import { isWithin, resolveForContainment, toAbsolute } from "./paths.ts";

export type ShellVerdict = "safe" | "escalate";

export interface ShellEvidence {
	verdict: ShellVerdict;
	/** Why it escalated / what the classifier should weigh. Never contains expanded variable values. */
	notes: string[];
	/** The commands that actually run, wrappers peeled (`env rm` → `rm`). */
	commands: string[];
	/** Resolved paths this command may write, with containment already decided. */
	writes: { token: string; resolved?: string; outsideCwd: boolean }[];
	/** Credential/secret paths named anywhere in the command (original tokens, never expanded). */
	sensitivePaths: string[];
	/** In-project paths whose contents execute later (`.git/hooks/*`, `.vscode/*.json`). */
	executionPrimitives: string[];
	/** Network-capable commands present (curl, ssh, …) — an egress signal for the classifier. */
	network: string[];
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

/** Commands that read and do not write, and are safe to fast-path. */
const READ_ONLY_COMMANDS = new Set([
	"basename",
	"cat",
	"cksum",
	"column",
	"comm",
	"cut",
	"date",
	"diff",
	"dirname",
	"du",
	"echo",
	"false",
	"file",
	"fold",
	"head",
	"hostname",
	"id",
	"join",
	"jq",
	"ls",
	"md5sum",
	"nl",
	"od",
	"paste",
	"printenv",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"rev",
	"rg",
	"sha1sum",
	"sha256sum",
	"shasum",
	"sort",
	"stat",
	"tail",
	"tr",
	"tree",
	"true",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
	"yes",
]);

/**
 * `grep` and friends take a pattern before their paths, so the first positional
 * is not a path token. Tracked separately to avoid classifying a regex as a file.
 */
const PATTERN_FIRST_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

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
 * git is **default-deny by subcommand**: only these read-only subcommands can be
 * fast-pathed, and everything else escalates. The original enumerated *mutating*
 * subcommands and allowed the rest, so `git rm`, `git mv`, `git archive`,
 * `git config`, and `git update-ref` all slipped through (review finding N11).
 * Enumerating the safe set instead means a git subcommand added upstream
 * tomorrow escalates rather than being silently permitted.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"blame",
	"branch", // listing; mutation forms carry flags, and any flag we do not model escalates
	"cat-file",
	"describe",
	"diff",
	"grep",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
	"tag", // listing only, same reasoning as branch
]);

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

/** Syntax we do not model at all; its presence alone forces escalation. */
export function hasUnmodelledSyntax(command: string): string | undefined {
	if (command.includes("\n")) return "spans multiple lines";
	if (/\$\(/.test(command)) return "uses command substitution $( )";
	if (/(^|[^\\])`/.test(command)) return "uses backtick command substitution";
	if (/<<</.test(command)) return "uses a here-string";
	if (/<</.test(command)) return "uses a heredoc";
	if (/[<>]\(/.test(command)) return "uses process substitution";
	// Brace expansion resolves to paths we cannot enumerate (review finding N3).
	if (/\{[^{}]*,[^{}]*\}/.test(command)) return "uses brace expansion, whose expanded paths cannot be checked";
	if (/\$\{?[A-Za-z_]/.test(command)) return "references environment variables, whose values are unknown here";
	if (/\beval\b|\bexec\b/.test(command)) return "uses eval/exec";
	if (/\|\s*(bash|sh|zsh|python|perl|node|ruby)\b/.test(command)) return "pipes into an interpreter";
	if (/base64\s+(-d|--decode)/.test(command)) return "decodes base64, which can hide the real command";
	return undefined;
}

/**
 * Split a command into pipeline/list segments and tokenize each. Unlike the
 * original, `<`, `>`, `&`, and `|` terminate a token even without surrounding
 * whitespace, so `cmd>file` and `a|b` are seen (review finding N4).
 */
export function parseCommand(command: string): { segments: Segment[]; parseFailed: boolean } {
	const segments: Segment[] = [];
	let tokens: Token[] = [];
	let redirects: string[] = [];
	let rawStart = 0;

	let current = "";
	let hadExpansion = false;
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
			tokens.push({ value: current, hadExpansion });
		}
		current = "";
		hadExpansion = false;
		quoted = false;
	};

	const pushSegment = (at: number) => {
		pushToken();
		if (tokens.length > 0 || redirects.length > 0) {
			segments.push({ tokens, redirects, raw: command.slice(rawStart, at).trim() });
		}
		tokens = [];
		redirects = [];
		rawStart = at + 1;
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
				// fd duplication — consume the fd and move on, no path involved.
				j++;
				while (j < command.length && /[0-9-]/.test(command[j])) j++;
				i = j - 1;
				continue;
			}
			pendingRedirect = ch === ">";
			i = j - 1;
			continue;
		}

		if (ch === "|" || ch === ";" || ch === "&") {
			// `&&`, `||`, `;`, `|`, `&` all end a segment. Any of them means the
			// next command is separate, which is all we need to know.
			pushSegment(i);
			if (command[i + 1] === ch) i++;
			continue;
		}

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

/** `find` actions that execute or write (review finding N7 adds the last four). */
function findHasAction(args: Token[]): boolean {
	return args.some(({ value }) =>
		["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprintf", "-fls", "-fprint", "-fprint0"].includes(value),
	);
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
 * Decide git: only an explicitly read-only subcommand with no flags we cannot
 * account for is safe. Returns undefined when safe, else the reason to escalate.
 */
function gitEscalationReason(args: Token[], isDirOutsideCwd: (dir: string) => boolean): string | undefined {
	let index = 0;
	while (index < args.length) {
		const token = args[index].value;
		if (!token.startsWith("-")) break;
		// `-c key=value` can reconfigure git into executing an arbitrary helper.
		if (token === "-c" || token.startsWith("-c=") || token === "--config-env") {
			return "passes git -c/--config-env, which can turn a read into code execution";
		}
		if (GIT_GLOBAL_VALUE_FLAGS.has(token)) {
			const value = args[index + 1]?.value;
			// `-C`/`--git-dir`/`--work-tree` retarget git at another directory. If that
			// directory escapes the working directory the operation is no longer
			// provably in-project, so escalate rather than skipping the flag blindly
			// (was review gap: `git -C /etc status` classified safe).
			if ((token === "-C" || token === "--git-dir" || token === "--work-tree") && value && isDirOutsideCwd(value)) {
				return `runs git ${token} ${value}, which points outside the working directory`;
			}
			index += 2;
			continue;
		}
		index++;
	}
	const subcommand = args[index]?.value?.toLowerCase();
	if (!subcommand) return undefined; // bare `git` prints help
	if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return `runs git ${subcommand}, which is not a read-only subcommand`;
	return undefined;
}

export interface AnalyzeInput {
	command: string;
	cwd: string;
	home: string;
}

/**
 * Classify a shell command. Never denies — see the module contract above.
 */
export function analyzeShellCommand({ command, cwd, home }: AnalyzeInput): ShellEvidence {
	const evidence: ShellEvidence = {
		verdict: "safe",
		notes: [],
		commands: [],
		writes: [],
		sensitivePaths: [],
		executionPrimitives: [],
		network: [],
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
	const escalate = (note: string, opts?: { contained?: boolean }) => {
		evidence.verdict = "escalate";
		if (!opts?.contained) uncontained = true;
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
		const absolute = toAbsolute(effectiveCwd, token, home);
		const resolved = resolveForContainment(absolute);
		const outsideCwd = resolved === undefined || !isWithin(containmentRoot, resolved);
		evidence.writes.push({ token, resolved, outsideCwd });
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
	};

	for (const segment of segments) {
		// Redirection targets are writes regardless of the command word: a bare
		// `> file` truncates/creates it with no command at all, and `git log > file`
		// writes it too. Check them first so the command-specific `continue`s below
		// (cd/git) can never skip a redirect (was review gap: bare-redirect writes and
		// read-only-command redirects were fast-pathed to "safe").
		for (const token of segment.redirects) checkWriteTarget(token);

		const { command: name, args, peeled } = resolvePayload(segment.tokens);
		if (!name) continue;
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
			const absolute = toAbsolute(effectiveCwd, value, home);
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
				effectiveCwd = toAbsolute(effectiveCwd, target, home);
				escalate(`changes directory to ${target}, so later paths in this command resolve elsewhere`);
			}
			continue;
		}

		if (name === "git") {
			// `git reset --hard` is an in-project whole-tree discard: escalate, but
			// mark it contained so the recoverability gate can clear it when the tree
			// is clean. Any other non-read-only git subcommand is uncontained.
			if (isWholeTreeGitReset(args)) {
				evidence.wholeTree = true;
				escalate("runs git reset --hard, which discards uncommitted changes in the working tree", {
					contained: true,
				});
				continue;
			}
			const reason = gitEscalationReason(args, (dir) => {
				const resolved = resolveForContainment(toAbsolute(effectiveCwd, dir, home));
				return resolved === undefined || !isWithin(containmentRoot, resolved);
			});
			if (reason) escalate(reason);
			continue;
		}

		if (SCRIPT_INTERPRETERS.has(name)) {
			escalate(`runs ${name}, whose script can read and write files this check cannot see`);
		}

		if (name === "find" && findHasAction(args)) {
			escalate("uses a find action that executes commands or writes files");
		}

		const isMutation = MUTATION_COMMANDS.has(name);
		const isDelete = DELETE_COMMANDS.has(name);
		// A delete confined to in-project paths is what the containment gate exists
		// to clear (subject to recoverability); any other mutation (cp/mv/tar/…)
		// stays uncontained and reaches the classifier as before.
		if (isMutation) escalate(`runs ${name}, which modifies the filesystem`, { contained: isDelete });

		if (!isMutation && !READ_ONLY_COMMANDS.has(name) && !PATTERN_FIRST_COMMANDS.has(name) && name !== "find") {
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

	return evidence;
}
