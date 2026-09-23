/**
 * The auto-mode transcript's `{"meta":{"gitStatus":…}}` line (pure), in the
 * Claude Code-compatible shape the ruleset describes.
 *
 * Before a shell command that can destroy uncommitted work, the harness runs
 * `git status` itself and puts the result directly above that command in the
 * classifier's `<transcript>`, so the classifier judges the tree's real state
 * instead of presuming it dirty. The ruleset says how to read it ("A
 * `gitStatus` of `{"clean":true}` clears the Irreversible Local Destruction
 * presume-dirty for that command; staged/modified/untracked counts … confirm
 * it"). A command qualifies when any pattern of a qualifying category
 * (`GIT_STATUS_CATEGORIES`) matches it, `monitor` commands included.
 */

type Pattern = { pattern: RegExp; category: string };

/** Bash command categories; `destructiveCategory` names a command by the first match. */
const BASH_PATTERNS: Pattern[] = [
	{ pattern: /\bgit\s+reset\s+--hard\b/, category: "git_reset_hard" },
	{ pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, category: "git_force_push" },
	{ pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/, category: "git_clean_force" },
	{ pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/, category: "git_checkout_dot" },
	{ pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/, category: "git_restore_dot" },
	{ pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/, category: "git_stash_drop" },
	{ pattern: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/, category: "git_branch_force_delete" },
	{ pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, category: "git_no_verify" },
	{ pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, category: "git_commit_amend" },
	{
		pattern: /(^|[;&|\n][ \t]*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n][ \t]*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
		category: "rm_recursive_force",
	},
	{ pattern: /(^|[;&|\n][ \t]*)rm\s+-[a-zA-Z]*[rR]/, category: "rm_recursive" },
	{ pattern: /(^|[;&|\n][ \t]*)rm\s+-[a-zA-Z]*f/, category: "rm_force" },
	{ pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, category: "sql_drop_truncate" },
	{ pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, category: "sql_delete_from" },
	{ pattern: /\bkubectl\s+delete\b/, category: "kubectl_delete" },
	{ pattern: /\bterraform\s+destroy\b/, category: "terraform_destroy" },
];

const REMOVE = "(?:^|[|;&\\n({])[ \\t]*(Remove-Item|rm|del|rd|rmdir|ri)\\b[^|;&\\n}]*";

/** PowerShell command categories, in the same first-match order. */
const POWERSHELL_PATTERNS: Pattern[] = [
	{ pattern: new RegExp(`${REMOVE}-Recurse\\b[^|;&\\n}]*-Force\\b`, "i"), category: "remove_item_recursive_force" },
	{ pattern: new RegExp(`${REMOVE}-Force\\b[^|;&\\n}]*-Recurse\\b`, "i"), category: "remove_item_recursive_force" },
	{ pattern: new RegExp(`${REMOVE}-Recurse\\b`, "i"), category: "remove_item_recursive" },
	{ pattern: new RegExp(`${REMOVE}-Force\\b`, "i"), category: "remove_item_force" },
	{ pattern: /\bClear-Content\b[^|;&\n]*\*/i, category: "clear_content_glob" },
	{ pattern: /\bFormat-Volume\b/i, category: "format_volume" },
	{ pattern: /\bClear-Disk\b/i, category: "clear_disk" },
	{ pattern: /\bgit\s+reset\s+--hard\b/i, category: "git_reset_hard" },
	{ pattern: /\bgit\s+push\b[^|;&\n]*\s+(--force|--force-with-lease|-f)\b/i, category: "git_force_push" },
	{ pattern: /\bgit\s+clean\b(?![^|;&\n]*(?:-[a-zA-Z]*n|--dry-run))[^|;&\n]*-[a-zA-Z]*f/i, category: "git_clean_force" },
	{ pattern: /\bgit\s+stash\s+(drop|clear)\b/i, category: "git_stash_drop" },
	{ pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, category: "sql_drop_truncate" },
	{ pattern: /\bStop-Computer\b/i, category: "stop_computer" },
	{ pattern: /\bRestart-Computer\b/i, category: "restart_computer" },
	{ pattern: /\bClear-RecycleBin\b/i, category: "clear_recycle_bin" },
];

/** The categories that get a gitStatus line: the ones that can destroy uncommitted work. */
export const GIT_STATUS_CATEGORIES: ReadonlySet<string> = new Set([
	"git_reset_hard",
	"git_checkout_dot",
	"git_restore_dot",
	"git_clean_force",
	"rm_recursive_force",
	"rm_recursive",
	"rm_force",
	"remove_item_recursive_force",
	"remove_item_recursive",
	"remove_item_force",
	"clear_content_glob",
]);

/** The destructive category of a shell command (first match, first 10,000 characters), or undefined. */
export function destructiveCategory(tool: "bash" | "powershell", command: string): string | undefined {
	const text = command.length > 10_000 ? command.slice(0, 10_000) : command;
	const patterns = tool === "powershell" ? POWERSHELL_PATTERNS : BASH_PATTERNS;
	return patterns.find(({ pattern }) => pattern.test(text))?.category;
}

/**
 * Whether this shell command gets a gitStatus line above it in the transcript.
 * Any qualifying pattern counts, not only the first match, so `git push
 * --force x && rm -rf y` gets the line for its `rm -rf`: the line only ever
 * adds ground truth.
 */
export function wantsGitStatusMeta(tool: "bash" | "powershell", command: string): boolean {
	const text = command.length > 10_000 ? command.slice(0, 10_000) : command;
	const patterns = tool === "powershell" ? POWERSHELL_PATTERNS : BASH_PATTERNS;
	return patterns.some(({ pattern, category }) => GIT_STATUS_CATEGORIES.has(category) && pattern.test(text));
}

/** The `git status` arguments for the line (the harness adds its own `-c` hardening). */
export const GIT_STATUS_META_ARGS: readonly string[] = ["status", "--porcelain", "--ignore-submodules=dirty", "--untracked-files=normal"];

/** The line's gitStatus value: `{clean: true}`, or the tree's counts. */
export type GitStatusMeta = { clean: true } | { staged: number; modified: number; untracked: number };

/** Summarize `git status --porcelain` output as clean, or staged/modified/untracked counts. */
export function gitStatusMeta(porcelain: string): GitStatusMeta {
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	for (const line of porcelain.split("\n")) {
		if (line.length < 2) continue;
		const [index, worktree] = [line[0], line[1]];
		if (index === "?" && worktree === "?") {
			untracked++;
			continue;
		}
		if (index !== " " && index !== "?") staged++;
		if (worktree !== " ") modified++;
	}
	return staged === 0 && modified === 0 && untracked === 0 ? { clean: true } : { staged, modified, untracked };
}
