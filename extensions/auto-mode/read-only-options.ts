/**
 * Option tables for the shell pre-gate's read-only commands (pure).
 *
 * The pre-gate may conclude "safe" only when it can prove a command reads and
 * nothing else. Until 2026-09-23 it proved that from the command's NAME and
 * never looked at the options: `git diff --output=f` wrote a file, `git grep
 * -O<prog>` and `rg --pre=<prog>` ran a program, `git branch -D` deleted a
 * branch, and `uniq in out` overwrote `out`, all fast-pathed as reads
 * (SECURITY-REVIEW-2026-09-23 H1). Each read-only command now has an explicit
 * table of the options it may carry; an option that is not in the table
 * escalates. A missing entry costs one classifier call, never a bypass.
 *
 * The tables must agree with how the real parser consumes values, or an
 * option can hide inside another option's value. A required value is taken
 * from the rest of a short-option cluster or from the next word, whatever
 * that word looks like (getopt and git's parse-options both do this), so
 * `-S -- --output=f` hides nothing: `--` is `-S`'s value and `--output=f` is
 * still parsed as an option. Where the arity is uncertain the tables say
 * "none", which only ever turns a value into an operand that gets read-checked.
 */

/**
 * How an option takes its value:
 * - `none`: never (`--name=v` is refused);
 * - `optional`: only attached (`--abbrev=7`, `-M50%`), never the next word;
 * - `required`: attached, or else the next word, unconditionally;
 * - `lastarg`: git's LASTARG_DEFAULT (`--contains [<commit>]`): the next word
 *   unless it starts with `-` or there is none;
 * - `two`: the next two words (jq's `--arg name value`).
 */
export type Arity = "none" | "optional" | "required" | "lastarg" | "two";

export interface OptionSpec {
	options: Record<string, Arity>;
	/**
	 * Every option is accepted and takes no value, so every following word is
	 * checked as an operand. Only for commands with no option that writes,
	 * executes, reaches the network or reads a list of files to open.
	 */
	lenient?: boolean;
	/** `-5`-style numeric options (`head -5`, `git log -3`). */
	numeric?: boolean;
	/** Options whose value names a file the command reads (checked like an operand). */
	fileValues?: readonly string[];
	/** The most operands the command may take and still only read (`uniq in out` writes `out`). */
	maxPositionals?: number;
	/** The first operand is a program, not a file (jq's filter). */
	programFirst?: boolean;
	/** A reason the operands make the command more than a read, or undefined. */
	operandReason?: (operands: readonly Word[]) => string | undefined;
	/** A reason a combination of options makes the command more than a checked read, or undefined. */
	optionsReason?: (seen: ReadonlySet<string>) => string | undefined;
	/**
	 * The command reads through symlinks found INSIDE a directory operand, one
	 * level down, unless one of these options is present. `diff dir1 dir2`
	 * compares same-named entries and dereferences them, so a symlink in a
	 * directory operand reaches outside with no `-r` needed
	 * (PREGATE-REVIEW-2026-09-23 A1). The analyzer checks it, because only it
	 * knows which operands resolve to directories.
	 */
	dereferencesDirEntries?: readonly string[];
}

/** A shell word as the pre-gate tokenizer produces it (shell-analysis.ts `Token`). */
export interface Word {
	value: string;
	/** An unquoted glob character makes bash expand the word. */
	glob?: boolean;
}

export interface ParsedOptions<W extends Word = Word> {
	/** Operands in order: words that are not options or option values. */
	positionals: W[];
	/** Values of `fileValues` options: files the command reads (an attached value is a word of its own). */
	fileValues: Word[];
	/** Every option seen, as written in the table (`-e`, `--regexp`). */
	seen: Set<string>;
}

export type OptionCheck<W extends Word = Word> = { ok: true; parsed: ParsedOptions<W> } | { ok: false; reason: string };

function words(list: string): string[] {
	return list.split(/\s+/).filter(Boolean);
}

/** Build a table from space-separated option lists, one per arity. */
export function table(arities: Partial<Record<Arity, string>>, extra: Omit<OptionSpec, "options"> = {}): OptionSpec {
	const options: Record<string, Arity> = {};
	for (const [arity, list] of Object.entries(arities) as [Arity, string][]) {
		for (const option of words(list)) options[option] = arity;
	}
	return { options, ...extra };
}

/** The only fields merge() carries; anything else is an operand rule or hook that must sit on the merged spec. */
const MERGEABLE_FIELDS = new Set(["options", "numeric", "fileValues"]);

function merge(...specs: OptionSpec[]): OptionSpec {
	const merged: OptionSpec = { options: {} };
	for (const spec of specs) {
		// Only option tables merge. A limit or hook would silently vanish from
		// every merged subcommand, so a spec carrying any non-mergeable field is
		// refused — by key, so a field added to OptionSpec later cannot slip past.
		const extra = Object.keys(spec).find((key) => !MERGEABLE_FIELDS.has(key));
		if (extra) throw new Error(`merge() only merges option tables; set '${extra}' on the merged spec itself`);
		Object.assign(merged.options, spec.options);
		if (spec.numeric) merged.numeric = true;
		if (spec.fileValues) merged.fileValues = [...(merged.fileValues ?? []), ...spec.fileValues];
	}
	return merged;
}

const LENIENT: OptionSpec = { options: {}, lenient: true };

/**
 * Parse `args` against `spec`. Refuses an option the table does not name, a
 * value attached to an option that takes none, and more operands than
 * `maxPositionals`. `--` ends the options; `-` alone is an operand (stdin).
 */
export function checkOptions<W extends Word>(spec: OptionSpec, args: readonly W[]): OptionCheck<W> {
	const parsed: ParsedOptions<W> = { positionals: [], fileValues: [], seen: new Set() };
	const fileValueOptions = new Set(spec.fileValues ?? []);
	let endOfOptions = false;

	/** Record an option's value when it names a file; a separate word keeps its glob flag. */
	const takeValue = (option: string, value: string | W | undefined) => {
		if (value === undefined || !fileValueOptions.has(option)) return;
		parsed.fileValues.push(typeof value === "string" ? { value } : value);
	};

	/**
	 * Consume the words a value-taking option at `i` takes when its value is
	 * not attached — the one place long options and short clusters agree on
	 * this — and return how many words were taken.
	 */
	const takeSeparateValue = (option: string, arity: Arity, i: number): number => {
		if (arity === "required") {
			takeValue(option, args[i + 1]);
			return 1;
		}
		if (arity === "lastarg") {
			const next = args[i + 1];
			if (next === undefined || next.value.startsWith("-")) return 0;
			takeValue(option, next);
			return 1;
		}
		if (arity === "two") {
			takeValue(option, args[i + 2]);
			return 2;
		}
		return 0;
	};

	for (let i = 0; i < args.length; i++) {
		const word = args[i].value;
		if (endOfOptions || word === "-" || !word.startsWith("-")) {
			parsed.positionals.push(args[i]);
			continue;
		}
		if (word === "--") {
			endOfOptions = true;
			continue;
		}
		if (spec.numeric && /^-[0-9]+$/.test(word)) continue;
		if (spec.lenient) {
			// Every option takes no value, so a cluster is all options.
			if (word.startsWith("--")) parsed.seen.add(word.split("=", 1)[0]);
			else for (const letter of word.slice(1)) parsed.seen.add(`-${letter}`);
			continue;
		}

		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const name = eq > 0 ? word.slice(0, eq) : word;
			const arity = spec.options[name];
			if (arity === undefined) return { ok: false, reason: `passes ${name}, an option not known to be read-only` };
			parsed.seen.add(name);
			if (eq > 0) {
				if (arity === "none") return { ok: false, reason: `passes a value to ${name}, which takes none` };
				takeValue(name, word.slice(eq + 1));
				continue;
			}
			// `optional` takes its value only attached (`--abbrev=7`).
			if (arity !== "optional") i += takeSeparateValue(name, arity, i);
			continue;
		}

		// A short cluster: `-la` is `-l -a`; a value-taking letter ends it.
		for (let j = 1; j < word.length; j++) {
			const name = `-${word[j]}`;
			const arity = spec.options[name];
			if (arity === undefined) return { ok: false, reason: `passes ${name}, an option not known to be read-only` };
			parsed.seen.add(name);
			if (arity === "none") continue;
			// The rest of the cluster is the value when there is one; otherwise a
			// value-taking letter (not `optional`) takes the next word(s).
			const rest = word.slice(j + 1);
			if (rest) takeValue(name, rest);
			else if (arity !== "optional") i += takeSeparateValue(name, arity, i);
			break;
		}
	}

	const optionsReason = spec.optionsReason?.(parsed.seen);
	if (optionsReason) return { ok: false, reason: optionsReason };
	if (spec.maxPositionals !== undefined && parsed.positionals.length > spec.maxPositionals) {
		return { ok: false, reason: `takes ${parsed.positionals.length} operands; past ${spec.maxPositionals} the command writes` };
	}
	// The count above is of words as written; bash expands one glob into as
	// many operands as it matches, so `uniq sample-*` reached uniq's output
	// operand (AUTO-MODE-SECURITY-REVIEW-2026-09-24 H4).
	const glob = spec.maxPositionals !== undefined ? parsed.positionals.find((word) => word.glob) : undefined;
	if (glob) return { ok: false, reason: `passes the glob ${glob.value}, which can expand past the ${spec.maxPositionals} operand(s) it may take and still only read` };
	return { ok: true, parsed };
}

// ---------------------------------------------------------------------------
// Plain commands
// ---------------------------------------------------------------------------

/*
 * Options that follow symbolic links found while recursing are left out of
 * every table (`grep -R`, `rg -L`, `du -L`, `tree -l`, find's `-L` and
 * `-follow`), and `ls -LR` and `diff -r` are refused below. Operands are
 * judged where they resolve, but a symlink deep inside an operand directory
 * is never seen, so following it reads outside the working directory. Claude
 * Code accepts these options; the forms that follow only operands (`-H`) stay.
 */
const FOLLOWS_WHILE_RECURSING = "follows symbolic links while it recurses, so it can read outside the working directory";

/** The checksum tools without `-c`/`--check`, which reads every file its list names. */
const CHECKSUM = table({
	none: "-b -t -s -w -z -0 -U --status --warn --strict --quiet --tag --binary --text --zero --ignore-missing --untagged --base64 --raw",
	required: "-a -o -l --algorithm --length",
});

const GREP = table(
	{
		none:
			"-a -b -c -E -F -G -H -h -i -I -l -L -n -o -q -r -s -U -v -w -x -y -z -Z -P -T --count --extended-regexp --fixed-strings --basic-regexp --perl-regexp --with-filename --no-filename --ignore-case --no-ignore-case --files-with-matches --files-without-match --line-number --only-matching --quiet --silent --recursive --no-messages --binary --invert-match --word-regexp --line-regexp --null-data --null --byte-offset --line-buffered --initial-tab",
		optional: "--color --colour",
		required:
			"-A -B -C -m -e -f -d -D --after-context --before-context --context --max-count --regexp --file --include --exclude --exclude-dir --binary-files --directories --devices --label",
	},
	{ numeric: true, fileValues: ["-f", "--file"] },
);

/**
 * ripgrep without `--pre`/`--pre-glob` (run a program per file),
 * `--hostname-bin` (runs a program) and `--ignore-file` (reads a named file).
 */
const RG = table(
	{
		none:
			"-i -s -S -w -x -v -l -c -n -N -H -I -o -p -q -u -U -F -P -a -z -0 -b -h -V --no-heading --heading --hidden --no-hidden --no-ignore --no-ignore-vcs --no-ignore-parent --no-ignore-dot --no-ignore-global --no-ignore-exclude --no-ignore-files --ignore --ignore-case --case-sensitive --smart-case --word-regexp --line-regexp --invert-match --files-with-matches --files-without-match --count --count-matches --line-number --no-line-number --with-filename --no-filename --only-matching --pretty --quiet --json --no-json --files --fixed-strings --pcre2 --no-pcre2 --multiline --no-multiline --multiline-dotall --text --null --null-data --trim --vimgrep --column --no-column --no-messages --stats --type-list --unrestricted --no-config --debug --trace --one-file-system --binary --no-require-git --crlf --passthru --include-zero --byte-offset --line-buffered --block-buffered --max-columns-preview --glob-case-insensitive --search-zip --no-search-zip --sort-files --help --version",
		required:
			"-e -f -g -t -T -A -B -C -m -d -j -M -r -E --regexp --file --glob --iglob --type --type-not --type-add --type-clear --after-context --before-context --context --max-count --max-depth --maxdepth --max-filesize --threads --max-columns --replace --context-separator --field-match-separator --field-context-separator --engine --encoding --path-separator --sort --sortr --color --colors --dfa-size-limit --regex-size-limit --hyperlink-format",
	},
	{ numeric: true, fileValues: ["-f", "--file"] },
);

/**
 * jq without `-f`, `--rawfile`, `--slurpfile` (read named files) and `-L`
 * (module search path). A program naming `env` or `ENV` is jq's printenv: jq
 * evaluates `$ENV` itself, so single quotes that keep bash from expanding it
 * do not make it inert, and jq also accepts `$ ENV` with a space
 * (AUTO-MODE-SECURITY-REVIEW-2026-09-24 H5, findings §32). `import` and
 * `include` load modules from jq's search path.
 */
const JQ = table(
	{
		none:
			"-r -j -a -c -n -e -s -S -C -M -R -h --tab --raw-output --raw-output0 --join-output --ascii-output --compact-output --null-input --exit-status --slurp --sort-keys --color-output --monochrome-output --raw-input --seq --stream --stream-errors --unbuffered --args --jsonargs --help --version",
		required: "--indent",
		two: "--arg --argjson",
	},
	{
		programFirst: true,
		operandReason: ([program]) => {
			if (!program) return undefined;
			if (/\b(?:env|ENV)\b/.test(program.value)) return "runs a jq program that reads the process environment";
			if (/\b(?:import|include)\b/.test(program.value)) return "runs a jq program that loads modules from jq's search path";
			return undefined;
		},
	},
);

/** sort without `-o`/`--output` (writes), `-T` (writes temp files), `--compress-program` (runs a program), `--files0-from`. */
const SORT = table(
	{
		none:
			"-b -d -f -g -i -M -h -n -R -r -V -c -C -m -s -u -z --ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --ignore-nonprinting --month-sort --human-numeric-sort --numeric-sort --random-sort --reverse --version-sort --merge --stable --unique --zero-terminated --debug",
		optional: "--check",
		required: "-k -t -S --key --field-separator --buffer-size --parallel --sort --random-source",
	},
	{ fileValues: ["--random-source"] },
);

/** uniq's second operand is its output file. */
const UNIQ = table(
	{
		none: "-c -d -D -u -i -z --count --repeated --unique --ignore-case --zero-terminated",
		optional: "--all-repeated --group",
		required: "-f -s -w --skip-fields --skip-chars --check-chars",
	},
	{ numeric: true, maxPositionals: 1 },
);

/** wc without `--files0-from` (a list of files to open). */
const WC = table({
	none: "-c -l -m -w -L --bytes --chars --lines --words --max-line-length --help --version",
	optional: "--total",
});

/** du without `-X`/`--exclude-from` and `--files0-from`. */
const DU = table({
	none:
		"-a -A -c -h -H -k -l -m -g -P -s -x -0 -b -D --si --apparent-size --all --bytes --total --summarize --dereference-args --no-dereference --one-file-system --human-readable --null --inodes --count-links --separate-dirs -S",
	optional: "--time",
	required: "-d -B -t -I --max-depth --block-size --threshold --exclude --time-style",
});

/** file without `-C` (compiles a magic file, writing it), `-m` and `-f` (read named files). */
const FILE = table({
	none:
		"-b -c -h -L -i -I -k -l -N -n -r -s -z -Z -0 -d -E -S --brief --dereference --no-dereference --keep-going --no-pad --raw --special-files --uncompress --uncompress-noreport --mime --mime-type --mime-encoding --extension --apple --no-sandbox --print0 --help --version",
	required: "-e -P -F --exclude --exclude-quiet --parameter --separator",
});

/** tree without `-o` (writes), `-R`/`-H` (together write HTML files), `--fromfile`. */
const TREE = table({
	none:
		"-a -d -f -x -i -q -N -Q -p -u -g -s -h -D -F -v -t -c -U -r -n -C -A -S -J -X -1 --prune --noreport --si --du --dirsfirst --filesfirst --gitignore --matchdirs --ignore-case --info --inodes --device --help --version",
	required: "-L -P -I --charset --filelimit --timefmt --sort",
});

/** diff without `--from-file`/`--to-file`/`-X` (their values are checked as reads) and `--paginate` (runs pr). */
const DIFF = table(
	{
		none:
			"-a -b -B -c -d -e -E -f -H -i -n -N -p -P -q -r -s -t -T -u -w -y -Z --brief --recursive --ignore-case --ignore-all-space --ignore-space-change --ignore-blank-lines --ignore-tab-expansion --ignore-trailing-space --text --new-file --unidirectional-new-file --report-identical-files --side-by-side --suppress-common-lines --left-column --strip-trailing-cr --minimal --speed-large-files --no-dereference --expand-tabs --initial-tab --suppress-blank-empty --normal --show-c-function",
		optional: "--unified --context --color",
		required:
			"-U -C -W -x -X -I -F -L -D -S --label --exclude --exclude-from --ignore-matching-lines --show-function-line --width --tabsize --ifdef --starting-file --from-file --to-file --palette --horizon-lines --line-format --old-line-format --new-line-format --unchanged-line-format --old-group-format --new-group-format --changed-group-format --unchanged-group-format",
	},
	{
		fileValues: ["-X", "--exclude-from", "--from-file", "--to-file"],
		// diff dereferences the entries of a directory operand (`-r` recurses,
		// but even one level follows a symlink) unless told not to.
		dereferencesDirEntries: ["--no-dereference"],
	},
);

/** date without `-s`/`--set` (sets the clock) and `-f` (GNU: reads a file of dates); an operand other than `+FORMAT` sets the clock. */
const DATE = table(
	{
		none: "-u -R -j -n --utc --universal --rfc-email --debug --help --version",
		optional: "-I --iso-8601 --rfc-3339",
		required: "-d -r -v --date --reference",
	},
	{
		// `-r FILE` / `--reference=FILE` read FILE's timestamp (BSD `-r` also takes seconds).
		fileValues: ["-r", "--reference"],
		operandReason: (operands) => (operands.some((word) => !word.value.startsWith("+")) ? "runs date with an operand, which sets the clock" : undefined),
	},
);

/** hostname with no operand (an operand sets the hostname). */
const HOSTNAME = table({ none: "-s -f -d -i -I -A --short --fqdn --long --domain --ip-address --all-ip-addresses --all-fqdns" }, { maxPositionals: 0 });

/**
 * The option table of every command the pre-gate may fast-path as a read.
 * A command absent from this map is not read-only.
 */
export const READ_ONLY_SPECS: Record<string, OptionSpec> = {
	basename: LENIENT,
	cat: LENIENT,
	cksum: CHECKSUM,
	column: LENIENT,
	comm: LENIENT,
	cut: LENIENT,
	date: DATE,
	diff: DIFF,
	dirname: LENIENT,
	du: DU,
	echo: LENIENT,
	false: LENIENT,
	file: FILE,
	fold: LENIENT,
	head: LENIENT,
	hostname: HOSTNAME,
	id: LENIENT,
	join: LENIENT,
	jq: JQ,
	ls: {
		...LENIENT,
		optionsReason: (seen) =>
			(seen.has("-L") || seen.has("--dereference")) && (seen.has("-R") || seen.has("--recursive")) ? `passes -L with -R, so it ${FOLLOWS_WHILE_RECURSING}` : undefined,
	},
	md5sum: CHECKSUM,
	nl: LENIENT,
	od: LENIENT,
	paste: LENIENT,
	// No options: bash's `printf -v NAME` assigns a shell variable, and
	// `printf -v PATH ./bin; ls` would run ./bin/ls. A `%n` conversion assigns
	// too, to the argument it consumes (`printf '%n' PATH` sets PATH to 0), with
	// flags and length modifiers (`%.0n`, `%ln`) and on format reuse
	// (AUTO-MODE-SECURITY-REVIEW-2026-09-24 H3, findings §32).
	printf: {
		options: {},
		operandReason: ([format]) =>
			format && /%[^%a-zA-Z]*[hlLqjzZt]*n/.test(format.value.replace(/%%/g, "")) ? "runs printf with a %n conversion, which assigns a shell variable" : undefined,
	},
	pwd: LENIENT,
	readlink: LENIENT,
	realpath: LENIENT,
	rev: LENIENT,
	sha1sum: CHECKSUM,
	sha256sum: CHECKSUM,
	shasum: CHECKSUM,
	sort: SORT,
	stat: LENIENT,
	tail: LENIENT,
	tr: LENIENT,
	tree: TREE,
	true: LENIENT,
	uname: LENIENT,
	uniq: UNIQ,
	wc: WC,
	which: LENIENT,
	whoami: LENIENT,
	yes: LENIENT,
	// Pattern-first: the first operand is the pattern unless -e/-f supplies it.
	grep: GREP,
	egrep: GREP,
	fgrep: GREP,
	rg: RG,
};

/** Options through which a pattern-first command gets its pattern, making every operand a path. */
export const PATTERN_OPTIONS = new Set(["-e", "-f", "--regexp", "--file"]);

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

/**
 * find's expression primaries and operators, by how many words each consumes.
 * The actions that execute or write (`-exec`, `-execdir`, `-ok`, `-okdir`,
 * `-delete`, `-fprint*`, `-fls`) are deliberately absent.
 */
const FIND_PRIMARIES: Record<string, 0 | 1> = Object.fromEntries([
	...words(
		"-print -print0 -ls -prune -quit -true -false -empty -nouser -nogroup -readable -writable -executable -depth -xdev -mount -noleaf -daystart -ignore_readdir_race -noignore_readdir_race -not -a -and -o -or ! ( ) , -nowarn -warn",
	).map((p) => [p, 0 as const]),
	...words(
		"-name -iname -path -ipath -wholename -iwholename -regex -iregex -type -xtype -size -newer -anewer -cnewer -mtime -mmin -atime -amin -ctime -cmin -Btime -Bmin -Bnewer -user -group -uid -gid -perm -maxdepth -mindepth -links -inum -samefile -lname -ilname -fstype -flags -regextype -printf -used -context",
	).map((p) => [p, 1 as const]),
]);

/** Primaries whose value names a file find stats (read-checked like a starting point). */
const FIND_FILE_PRIMARIES = new Set(["-newer", "-anewer", "-cnewer", "-Bnewer", "-samefile"]);

/**
 * Parse a find command line. Returns its starting points and the file values
 * of `-newer`-style primaries, or the reason it is not read-only.
 */
export function checkFind<W extends Word>(args: readonly W[]): { ok: true; paths: W[] } | { ok: false; reason: string } {
	let i = 0;
	const paths: W[] = [];
	// Leading options: clusters of the no-value letters, `-O<level>`, and
	// `-D <debug>` / BSD's `-f <path>` as separate words. Anything else that
	// starts with `-` is the expression (`-fprint` is not `-f print`).
	while (i < args.length) {
		const word = args[i].value;
		// No `-L` (follow every symlink): see FOLLOWS_WHILE_RECURSING.
		if (/^-[HPEXdsx]+$/.test(word) || /^-O[0-9]$/.test(word)) {
			i++;
		} else if (word === "-D") {
			i += 2;
		} else if (word === "-f" && i + 1 < args.length) {
			paths.push(args[i + 1]);
			i += 2;
		} else break;
	}
	// Starting points: everything up to the first expression word.
	while (i < args.length) {
		const word = args[i].value;
		if (word.startsWith("-") || word === "!" || word === "(" || word === ")") break;
		paths.push(args[i]);
		i++;
	}
	// The expression.
	for (; i < args.length; i++) {
		const word = args[i].value;
		const newer = /^-newer[aBcmt][aBcmt]$/.test(word);
		const consumes = newer ? 1 : FIND_PRIMARIES[word];
		if (consumes === undefined) return { ok: false, reason: `uses find ${word}, which is not a known read-only primary` };
		if (consumes === 1) {
			const value = args[i + 1];
			if (value !== undefined && (FIND_FILE_PRIMARIES.has(word) || newer)) paths.push(value);
			i++;
		}
	}
	return { ok: true, paths };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * git's global options that may precede a read-only subcommand. `-C` is
 * validated by the caller (it must stay inside the working directory);
 * `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path`,
 * `--namespace` and everything else escalate: each can point git at a
 * configuration or repository the check has not seen.
 */
export const GIT_GLOBAL_SAFE = new Set([
	"--no-pager",
	"-P",
	"--no-optional-locks",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-replace-objects",
	"--version",
]);

const GIT_COLOR = table({ none: "--no-color", optional: "--color" });

/**
 * Diff output options shared by diff, log and show, without `--output`
 * (writes), `--ext-diff`/`--textconv` (run configured programs) and `-O`
 * (reads an order file).
 */
const GIT_DIFF = merge(
	GIT_COLOR,
	table({
		none:
			"-p -u -s -D -R -a -b -w -W -z -t -m -c --patch --no-patch --raw --patch-with-raw --patch-with-stat --numstat --shortstat --cumulative --summary --name-only --name-status --no-color-moved --no-renames --rename-empty --no-rename-empty --check --full-index --binary --find-copies-harder --irreversible-delete --pickaxe-all --pickaxe-regex --no-relative --text --ignore-cr-at-eol --ignore-space-at-eol --ignore-space-change --ignore-all-space --ignore-blank-lines --function-context --exit-code --quiet --no-ext-diff --no-textconv --no-prefix --default-prefix --ita-invisible-in-index --ita-visible-in-index --minimal --patience --histogram --compact-summary --indent-heuristic --no-indent-heuristic --cc --dd --no-diff-merges --combined-all-paths --remerge-diff --no-abbrev",
		optional:
			"--stat --dirstat --submodule --color-moved --word-diff --color-words --abbrev -B --break-rewrites -M --find-renames -C --find-copies --relative --ignore-submodules",
		required:
			"-U -l -S -G -I --unified --color-moved-ws --word-diff-regex --ws-error-highlight --diff-filter --find-object --ignore-matching-lines --inter-hunk-context --src-prefix --dst-prefix --line-prefix --anchored --diff-algorithm --stat-width --stat-name-width --stat-count --stat-graph-width --output-indicator-new --output-indicator-old --output-indicator-context --diff-merges",
	}),
);

/** Commit selection shared by log and shortlog. */
const GIT_REVS = table(
	{
		none:
			"-i -E -F -P -g --all --not --all-match --invert-grep --regexp-ignore-case --extended-regexp --fixed-strings --perl-regexp --basic-regexp --merges --no-merges --no-min-parents --no-max-parents --first-parent --reverse --topo-order --date-order --author-date-order --follow --full-history --simplify-merges --simplify-by-decoration --dense --sparse --left-right --left-only --right-only --cherry-pick --cherry-mark --cherry --boundary --do-walk --walk-reflogs --reflog --bisect --stdin --ignore-missing",
		optional: "--branches --tags --remotes --ancestry-path --no-walk",
		required:
			"-n --max-count --skip --since --after --until --before --since-as-filter --author --committer --grep --grep-reflog --min-parents --max-parents --glob --exclude",
	},
	{ numeric: true },
);

/** Commit formatting shared by log and show, without `--show-signature` (runs the configured gpg program). */
const GIT_LOG_FORMAT = table({
	none:
		"--oneline --abbrev-commit --no-abbrev-commit --no-decorate --source --graph --relative-date --parents --children --no-notes --no-expand-tabs --log-size --mailmap --no-mailmap --use-mailmap --no-use-mailmap --clear-decorations --no-standard-notes --standard-notes --show-pulls",
	optional: "--pretty --decorate --notes --expand-tabs --show-linear-break",
	required: "--format --date --encoding --decorate-refs --decorate-refs-exclude",
});

/** List options of `git branch`; operands are allowed only with `-l`/`--list`, since a bare operand creates a branch. */
const GIT_BRANCH = table({
	none: "-l -a -r -v -q -i --list --all --remotes --verbose --quiet --no-color --no-column --no-abbrev --ignore-case --omit-empty --show-current",
	optional: "--color --column --abbrev",
	required: "--points-at --sort --format",
	lastarg: "--contains --no-contains --merged --no-merged",
});

/** List options of `git tag`, without `-v`/`--verify` (runs gpg); operands only with `-l`/`--list`. */
const GIT_TAG = table({
	none: "-l -i --list --no-column --ignore-case --omit-empty --no-color",
	optional: "-n --color --column",
	required: "--points-at --sort --format",
	lastarg: "--contains --no-contains --merged --no-merged",
});

export const GIT_SUBCOMMAND_SPECS: Record<string, OptionSpec> = {
	blame: merge(
		GIT_COLOR,
		table({
			none: "-b -f -n -p -l -t -s -e -w -c --root --show-stats --score-debug --show-name --show-number --porcelain --line-porcelain --incremental --show-email --reverse --first-parent --progress --no-progress --minimal --color-lines --color-by-age",
			optional: "-M -C --abbrev",
			required: "-L --date --encoding --ignore-rev",
		}),
	),
	branch: GIT_BRANCH,
	"cat-file": table({
		none: "-t -s -e -p -Z --batch-all-objects --buffer --unordered --follow-symlinks --allow-unknown-type --mailmap --no-mailmap --use-mailmap --no-use-mailmap",
		optional: "--batch --batch-check --batch-command",
	}),
	describe: table({
		none: "--all --tags --contains --exact-match --debug --long --always --first-parent",
		optional: "--dirty --broken --abbrev",
		required: "--candidates --match --exclude",
	}),
	diff: merge(GIT_DIFF, table({ none: "--cached --staged --merge-base -1 -2 -3 --base --ours --theirs" })),
	grep: merge(
		GIT_COLOR,
		table(
			{
				none:
					"-a -i -I -r -w -v -h -H -E -G -P -F -n -l -L -z -o -c -p -W -q --text --no-textconv --ignore-case --no-recursive --recursive --word-regexp --invert-match --full-name --extended-regexp --basic-regexp --perl-regexp --fixed-strings --line-number --column --files-with-matches --name-only --files-without-match --null --only-matching --count --break --heading --show-function --function-context --and --or --not --all-match --quiet --cached --untracked --no-exclude-standard --exclude-standard --recurse-submodules",
				required: "-A -B -C -m -e --max-depth --after-context --before-context --context --max-count --threads",
			},
			{ numeric: true },
		),
	),
	log: merge(GIT_REVS, GIT_LOG_FORMAT, GIT_DIFF, table({ required: "-L" })),
	"ls-files": table({
		none: "-c -d -m -o -i -s -u -k -z -t -v -f --cached --deleted --modified --others --ignored --stage --unmerged --killed --directory --no-empty-directory --eol --deduplicate --full-name --recurse-submodules --debug --sparse --error-unmatch --exclude-standard --resolve-undo",
		optional: "--abbrev",
		required: "-x --exclude --exclude-per-directory --with-tree --format",
	}),
	"ls-tree": table({
		none: "-d -r -t -l -z --long --name-only --name-status --object-only --full-name --full-tree",
		optional: "--abbrev",
		required: "--format",
	}),
	"rev-parse": table({
		none:
			"-q --verify --quiet --sq --not --symbolic --symbolic-full-name --all --show-toplevel --show-superproject-working-tree --show-prefix --show-cdup --git-dir --git-common-dir --absolute-git-dir --is-inside-git-dir --is-inside-work-tree --is-bare-repository --is-shallow-repository --shared-index-path --show-ref-format --local-env-vars --revs-only --no-revs --flags --no-flags --end-of-options",
		optional: "--abbrev-ref --short --branches --tags --remotes --show-object-format",
		required: "--glob --exclude --disambiguate --git-path --path-format --since --after --until --before --default --prefix",
	}),
	shortlog: merge(
		GIT_REVS,
		table({ none: "-n -s -e -c --numbered --summary --email --committer", optional: "--format -w", required: "--group" }),
	),
	show: merge(GIT_LOG_FORMAT, GIT_DIFF, table({ none: "--first-parent" })),
	"show-ref": table({
		none: "-d -s -q --head --heads --branches --tags --dereference --verify --quiet --exists",
		optional: "--hash --abbrev --exclude-existing",
	}),
	status: table({
		none: "-s -b -v -z --short --branch --show-stash --long --verbose --no-column --ahead-behind --no-ahead-behind --renames --no-renames",
		optional: "--porcelain -u --untracked-files --ignore-submodules --ignored --column --find-renames",
	}),
	tag: GIT_TAG,
};

/**
 * Whether a git subcommand's operands are allowed: `branch` and `tag` create
 * refs from a bare operand, so they only list when `-l`/`--list` is present.
 */
export function gitOperandsAllowed(subcommand: string, parsed: ParsedOptions): boolean {
	if (subcommand !== "branch" && subcommand !== "tag") return true;
	return parsed.positionals.length === 0 || parsed.seen.has("-l") || parsed.seen.has("--list");
}
