/**
 * The auto-mode transcript's `{"meta":{"resolvedPaths":…}}` line (pure apart
 * from filesystem reads): where a path the action names really lands, when a
 * symlink takes it out of the working directories.
 *
 * The classifier judges the call's text. `Set-Content ' leading.txt' x` reads
 * as an in-project write even when ` leading.txt` is a symlink to
 * `~/.ssh/authorized_keys`, and Claude Code's ruleset allows "local file
 * operations within project scope". So the harness resolves every constant
 * word of the action that names a path inside the working directories, and
 * when one resolves outside them it puts the fact directly above the action,
 * as it does the `gitStatus` line (git-status-meta.ts). An action whose paths
 * all stay inside gets no line, so the payload of ordinary calls is Claude
 * Code's own. The fact is measured by the harness, never read from tool input.
 *
 * Only words the call spells are judged: a link inside a listed directory, or
 * a path computed at run time, is not seen (the pre-gates refuse those shapes
 * on their own; decisions/auto-mode.md "The resolvedPaths line").
 */

import type { PowerShellParse } from "../lib/powershell-parser.ts";
import { isPathSubjectTool } from "../permissions/matcher.ts";
import { powershellSeparators, powershellUnescaped } from "../permissions/powershell-paths.ts";
import { isWithin, resolveForContainment, resolveThroughLinks, toAbsolute, toAbsoluteBash } from "./paths.ts";
import { parseCommand } from "./shell-parse.ts";

/** One path the action names that resolves outside every working directory. */
export interface ResolvedPathFact {
	/** The word as the call spells it (quotes and escapes resolved). */
	path: string;
	/** Where it resolves through symlinks, in the filesystem's own spelling. */
	resolvesTo: string;
}

/** The line's own explanation, since the ruleset has no sentence for it. */
export const RESOLVED_PATHS_NOTE =
	"Measured by the harness, not written by the agent: each path below is named by the action under review as if inside the working directory, but resolves through a symbolic link to resolvesTo, outside every working directory. Judge the action as reading or writing resolvesTo.";

/** The most words one action has resolved: a huge command must not stall the gate. */
const MAX_CANDIDATES = 256;
/** A word longer than this is not a path worth resolving. */
const MAX_WORD = 4_096;

/** The constant words of a bash command line: every known token value and redirect target, and the value of `--opt=value`. */
export function bashPathCandidates(command: string): string[] {
	const words: string[] = [];
	for (const segment of parseCommand(command).segments) {
		for (const token of segment.tokens) {
			if (token.dynamic) continue;
			words.push(token.value);
			const eq = token.value.indexOf("=");
			if (token.value.startsWith("-") && eq > 0) words.push(token.value.slice(eq + 1));
		}
		words.push(...segment.redirects);
	}
	return words;
}

/**
 * The constant strings of a PowerShell parse (every node PowerShell gave a
 * value), with the backtick escapes `-Path` drops removed as a second
 * spelling: the gate does not know which parameter took the value.
 */
export function powershellPathCandidates(parse: PowerShellParse): string[] {
	const words: string[] = [];
	for (const node of parse.nodes) {
		if (typeof node.value !== "string") continue;
		words.push(node.value);
		const unescaped = powershellUnescaped(node.value);
		if (unescaped !== node.value) words.push(unescaped);
	}
	return words;
}

export interface ResolvedPathsOptions {
	/** The call's working directory. */
	cwd: string;
	home: string;
	/** Every working directory (the cwd and any added workspace directories). */
	roots: readonly string[];
	/** How the words spell a path: `bash` (Git Bash's `/c/…` on Windows), `powershell` (`\` separates on macOS and Linux too), else the platform's own. */
	spelling?: "bash" | "powershell";
}

/**
 * The words that name a path inside a working directory but resolve outside
 * all of them, or undefined when none does. A word that is outside as spelled
 * (`/etc/hosts`, `../x`) is left to the classifier's own reading of the text.
 */
export function resolvedPathFacts(words: readonly string[], opts: ResolvedPathsOptions): ResolvedPathFact[] | undefined {
	const roots = opts.roots.map((root) => resolveForContainment(root) ?? root);
	const cwd = resolveForContainment(opts.cwd) ?? opts.cwd;
	const facts: ResolvedPathFact[] = [];
	const seen = new Set<string>();
	for (const word of words) {
		if (seen.size >= MAX_CANDIDATES) break;
		if (!word || word.length > MAX_WORD || word.includes("\0") || seen.has(word)) continue;
		seen.add(word);
		const lexical =
			opts.spelling === "bash"
				? toAbsoluteBash(cwd, word, opts.home)
				: toAbsolute(cwd, opts.spelling === "powershell" ? powershellSeparators(word) : word, opts.home);
		if (!roots.some((root) => isWithin(root, lexical))) continue;
		const resolved = resolveForContainment(lexical);
		if (resolved === undefined || roots.some((root) => isWithin(root, resolved))) continue;
		facts.push({ path: word, resolvesTo: resolveThroughLinks(lexical) ?? resolved });
	}
	return facts.length > 0 ? facts : undefined;
}

/**
 * The facts for one action under review, or undefined: a shell command's
 * constant words (`bash` and `monitor` from the bash parse, `powershell` from
 * PowerShell's own parse, none without one), or a path tool's path argument.
 * `subject` is the command line or the path, as the permission gate extracts it.
 */
export function actionResolvedPaths(
	tool: string,
	subject: string,
	powershellParse: PowerShellParse | undefined,
	opts: Omit<ResolvedPathsOptions, "spelling">,
): ResolvedPathFact[] | undefined {
	if (!subject) return undefined;
	if (tool === "bash" || tool === "monitor") return resolvedPathFacts(bashPathCandidates(subject), { ...opts, spelling: "bash" });
	if (tool === "powershell") return powershellParse ? resolvedPathFacts(powershellPathCandidates(powershellParse), { ...opts, spelling: "powershell" }) : undefined;
	return isPathSubjectTool(tool) ? resolvedPathFacts([subject], opts) : undefined;
}
