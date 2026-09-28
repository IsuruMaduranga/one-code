/**
 * The cmdlets the PowerShell pre-gate may clear, and the parameters each may
 * be called with (pure): the PowerShell twin of `auto-mode/read-only-options.ts`
 * (decisions/windows.md "The PowerShell pre-gate reads PowerShell's own parse").
 *
 * Parameters are named as PowerShell's static binder reports them: the
 * canonical name, after aliases (`-LP`, `-First`) and abbreviations (`-pa`)
 * are resolved, and positional arguments assigned (`Select-String TODO a.txt`
 * binds `Pattern` and `Path`). A parameter outside a cmdlet's table is not
 * cleared, so a cmdlet is proved by its parameters, not its name. Left out on
 * purpose, everywhere: `-Credential` (another identity), `-ComputerName`
 * (another machine), `-*Variable` (sets a session variable), `-UseTransaction`,
 * `-FollowSymlink` (recursion through links, which the path checks cannot
 * see), `-Wait` (never returns), `-RelativeBasePath` and `-InputStream`.
 *
 * - `read`: the read-only cmdlets (Claude Code's allowlist, plus the in-process
 *   pipeline cmdlets and `Where-Object`/`ForEach-Object` with a checked script
 *   block). `paths` are judged where they resolve; `scriptBlocks` may hold only
 *   the expression subset `powershell-tree.ts` checks.
 * - `write`: Claude Code's acceptEdits cmdlets, and nothing else: `New-Item`,
 *   `Copy-Item`, `Move-Item` and the rest are left to the classifier, as
 *   Claude Code leaves them to a prompt.
 */

export interface CmdletSpec {
	/** Parameters naming a path the cmdlet reads (read cmdlets) or writes (write cmdlets). */
	paths?: readonly string[];
	/** Parameters that take no value. */
	switches?: readonly string[];
	/** Parameters that take a constant value that is not a path. */
	values?: readonly string[];
	/** Parameters that take a script block, checked by `powershell-tree.ts`. */
	scriptBlocks?: readonly string[];
	/** Allowed after a pipe (`|`) as well as at a pipeline's head. */
	tail?: boolean;
}

/** Common parameters every cmdlet takes; the `*Variable` ones are left out (they set session variables). */
const COMMON_SWITCHES = ["Verbose", "Debug"] as const;
const COMMON_VALUES = ["ErrorAction", "WarningAction", "InformationAction", "ProgressAction", "OutBuffer"] as const;

const FILTERS = ["Filter", "Include", "Exclude"] as const;
const FORMAT_SWITCHES = ["Force", "DisplayError", "ShowError"] as const;

/** Keyed by the lowercase cmdlet name. */
export const READ_CMDLETS: Readonly<Record<string, CmdletSpec>> = Object.freeze({
	"get-childitem": {
		paths: ["Path", "LiteralPath"],
		switches: ["Recurse", "Force", "Name", "Directory", "File", "Hidden", "ReadOnly", "System"],
		values: [...FILTERS, "Depth", "Attributes"],
	},
	"get-content": {
		paths: ["Path", "LiteralPath"],
		switches: ["Force", "Raw", "AsByteStream"],
		values: [...FILTERS, "ReadCount", "TotalCount", "Tail", "Delimiter", "Encoding", "Stream"],
	},
	"get-item": { paths: ["Path", "LiteralPath"], switches: ["Force"], values: [...FILTERS, "Stream"] },
	"test-path": { paths: ["Path", "LiteralPath"], switches: ["IsValid"], values: [...FILTERS, "PathType", "OlderThan", "NewerThan"] },
	"resolve-path": { paths: ["Path", "LiteralPath"], switches: ["Relative", "Force"] },
	"get-filehash": { paths: ["Path", "LiteralPath"], values: ["Algorithm"] },
	"get-acl": { paths: ["Path", "LiteralPath"], switches: ["Audit", "AllCentralAccessPolicies"], values: [...FILTERS] },
	"format-hex": { paths: ["Path", "LiteralPath"], switches: ["Raw"], values: ["InputObject", "Encoding", "Count", "Offset"] },
	"select-string": {
		paths: ["Path", "LiteralPath"],
		switches: ["SimpleMatch", "CaseSensitive", "Quiet", "List", "NotMatch", "AllMatches", "NoEmphasis", "Raw"],
		values: ["Pattern", "InputObject", "Include", "Exclude", "Encoding", "Context", "Culture"],
		tail: true,
	},
	"get-location": {},
	"get-process": { switches: ["IncludeUserName", "Module", "FileVersionInfo"], values: ["Name", "Id"] },
	"get-service": { switches: ["DependentServices", "RequiredServices"], values: ["Name", "DisplayName", "Include", "Exclude"] },
	"write-output": { switches: ["NoEnumerate"], values: ["InputObject"], tail: true },
	"write-host": { switches: ["NoNewline"], values: ["Object", "Separator", "ForegroundColor", "BackgroundColor"], tail: true },
	// In-process pipeline cmdlets: they shape objects already in memory.
	"select-object": {
		switches: ["Unique", "Wait", "CaseInsensitive"],
		values: ["Property", "ExcludeProperty", "ExpandProperty", "First", "Last", "Skip", "SkipLast", "Index", "SkipIndex"],
		tail: true,
	},
	"sort-object": {
		switches: ["Descending", "Unique", "CaseSensitive", "Stable"],
		values: ["Top", "Bottom", "Culture"],
		scriptBlocks: ["Property"],
		tail: true,
	},
	"measure-object": {
		switches: ["Sum", "Average", "Maximum", "Minimum", "Line", "Word", "Character", "IgnoreWhiteSpace", "StandardDeviation", "AllStats"],
		values: ["Property"],
		tail: true,
	},
	"group-object": { switches: ["NoElement", "AsHashTable", "AsString", "CaseSensitive"], values: ["Culture"], scriptBlocks: ["Property"], tail: true },
	"convertfrom-json": { switches: ["AsHashtable", "NoEnumerate"], values: ["InputObject", "Depth", "DateKind"], tail: true },
	"out-string": { switches: ["Stream", "NoNewline"], values: ["Width"], tail: true },
	"format-table": {
		switches: [...FORMAT_SWITCHES, "AutoSize", "Wrap", "HideTableHeaders", "RepeatHeader"],
		values: ["Property", "GroupBy", "View"],
		tail: true,
	},
	"format-list": { switches: [...FORMAT_SWITCHES], values: ["Property", "GroupBy", "View"], tail: true },
	"format-wide": { switches: [...FORMAT_SWITCHES, "AutoSize"], values: ["Property", "Column", "GroupBy", "View"], tail: true },
	"format-custom": { switches: [...FORMAT_SWITCHES], values: ["Property", "Depth", "GroupBy", "View"], tail: true },
	// A script block that reads `$_` and compares; `-MemberName` is left out:
	// `ForEach-Object Delete` calls the input's Delete() method. Their safety
	// rests on powershell-tree.ts `checkScriptBlock`, which every
	// `scriptBlocks` parameter goes through: a new parameter here that takes
	// code or names a member must be one it checks.
	"where-object": {
		switches: [
			"EQ", "NE", "GT", "GE", "LT", "LE", "Like", "NotLike", "Match", "NotMatch", "Contains", "NotContains", "In", "NotIn",
			"Is", "IsNot", "Not", "CEQ", "CNE", "CGT", "CGE", "CLT", "CLE", "CLike", "CNotLike", "CMatch", "CNotMatch",
			"CContains", "CNotContains", "CIn", "CNotIn",
		],
		values: ["Property", "Value"],
		scriptBlocks: ["FilterScript"],
		tail: true,
	},
	"foreach-object": { scriptBlocks: ["Process"], tail: true },
	"out-null": { tail: true },
});

/** The PowerShell cmdlets Claude Code allows in acceptEdits mode, and their parameters. */
export const WRITE_CMDLETS: Readonly<Record<string, CmdletSpec>> = Object.freeze({
	"set-content": {
		paths: ["Path", "LiteralPath"],
		switches: ["PassThru", "Force", "WhatIf", "Confirm", "NoNewline", "AsByteStream"],
		values: ["Value", ...FILTERS, "Encoding", "Stream"],
	},
	"add-content": {
		paths: ["Path", "LiteralPath"],
		switches: ["PassThru", "Force", "WhatIf", "Confirm", "NoNewline", "AsByteStream"],
		values: ["Value", ...FILTERS, "Encoding", "Stream"],
	},
	"remove-item": { paths: ["Path", "LiteralPath"], switches: ["Recurse", "Force", "WhatIf", "Confirm"], values: [...FILTERS, "Stream"] },
	"clear-content": { paths: ["Path", "LiteralPath"], switches: ["Force", "WhatIf", "Confirm"], values: [...FILTERS, "Stream"] },
});

/**
 * Pipeline tails a write line may end in (Claude Code's safe output
 * cmdlets): they format or drop what the write passes on.
 */
export const WRITE_TAILS = new Set(["out-null", "out-string", "format-table", "format-list", "format-wide", "select-object", "sort-object", "measure-object", "write-output"]);

/**
 * The upstream cmdlets a `Select-String` after a pipe may read from. It
 * searches the files behind `FileInfo` input (from `Get-ChildItem` and
 * `Get-Item`), so an object source that could carry an arbitrary path
 * (`ConvertFrom-Json`) must not feed it.
 */
export const SELECT_STRING_SOURCES = new Set(["get-content", "get-childitem", "get-item", "select-string", "where-object", "sort-object", "select-object", "out-string"]);

/**
 * Native commands the read-only list names (Windows), and the `/X` switches
 * each may take (`c:` takes a value, as in `/C:text`); every other argument
 * is judged as a path. Left out: findstr's `/S` and where.exe's `/R`, which
 * recurse, and findstr's `/F:`, `/G:` and `/D:`, which name more files.
 */
const FINDSTR_SWITCHES = new Set(["b", "e", "l", "r", "i", "x", "v", "n", "m", "o", "p", "off", "offline", "a:", "c:"]);
export const READ_APPLICATIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	findstr: FINDSTR_SWITCHES,
	"findstr.exe": FINDSTR_SWITCHES,
	"where.exe": new Set(["q", "f", "t"]),
});

/** How one argument to a read-only application reads: a switch it may take, one it may not, or a path. */
export function applicationArgument(application: string, argument: string): "switch" | "refused" | "path" {
	const switches = READ_APPLICATIONS[application.toLowerCase()];
	const flag = /^\/([A-Za-z]+)(:.*)?$/s.exec(argument);
	if (!switches || !flag) return "path";
	const name = flag[1].toLowerCase();
	return switches.has(flag[2] === undefined ? name : `${name}:`) ? "switch" : "refused";
}

/** The modules a cleared cmdlet must come from: PowerShell's own. */
export const TRUSTED_MODULES = new Set([
	"microsoft.powershell.management",
	"microsoft.powershell.utility",
	"microsoft.powershell.core",
	"microsoft.powershell.security",
]);

/**
 * Whether `spelled` (as typed, without its dash) names one of `spec`'s
 * switches by PowerShell's rule: the whole name or a prefix of it.
 */
export function isSwitchSpelling(spec: CmdletSpec, spelled: string): boolean {
	const lower = spelled.toLowerCase();
	return lower.length > 0 && [...(spec.switches ?? []), ...COMMON_SWITCHES].some((name) => name.toLowerCase().startsWith(lower));
}

/** How `parameter` may appear on `spec`: as a path, a script block, a switch or a value; undefined when not at all. */
export function parameterKind(spec: CmdletSpec, parameter: string): "path" | "switch" | "value" | "scriptBlock" | undefined {
	const has = (list: readonly string[] | undefined) => list?.some((name) => name.toLowerCase() === parameter.toLowerCase()) ?? false;
	if (has(spec.paths)) return "path";
	if (has(spec.scriptBlocks)) return "scriptBlock";
	if (has(spec.switches) || has(COMMON_SWITCHES)) return "switch";
	if (has(spec.values) || has(COMMON_VALUES)) return "value";
	return undefined;
}
