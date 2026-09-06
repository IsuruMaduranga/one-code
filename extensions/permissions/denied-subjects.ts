/**
 * Path-like tokens of a denied call's subject (pure).
 *
 * When a permission rule refuses a call, the thing the user protected is
 * usually a path inside the subject — `rm scripts/slow_build.sh` is denied
 * because of the `rm`, but what a circumvention would still be aiming at is
 * `scripts/slow_build.sh`. Auto mode uses these tokens to refuse an
 * equivalent-effect retry of a denied action (WEAK-MODEL-REVIEW-2026-09-06 H2:
 * a rule denial was followed by `python3 -c "os.remove(…)"`, which the
 * classifier then cleared on the user's own "delete this file").
 *
 * This is deliberately NOT a model judgement. A rule is a decision the user
 * already made, so no classifier — however capable — should be asked to
 * re-litigate it, and a gate whose strength depends on which model happens to
 * be screening is not a gate. The earlier attempt did key this on the session
 * model's tier, refusing to let a `tiny` model screen itself; that punished a
 * whole class of models on a price-and-name heuristic rather than on measured
 * competence, and it was the wrong lever.
 *
 * What keeps the rule narrow is `readOnly`: the shell pre-gate's "safe" verdict
 * (auto-mode/shell-analysis.ts) clears an inspection of the same path, so
 * `cat`, `grep` and `ls` on a file whose deletion was denied are untouched.
 * Anything else that names it — an interpreter one-liner, a truncate, a move,
 * an editing tool — is refused, which is the blind spot a command-shape
 * analysis could never cover on its own.
 */

/** Shell metacharacters, quotes and separators a path can be wrapped in. */
const SEPARATORS = /[\s'"`(),;|&<>{}[\]]+/;

/** Words that name no target of their own and would match half the session. */
const NOISE = new Set([
	"true",
	"false",
	"null",
	"none",
	"self",
	"this",
	"import",
	"print",
	"python",
	"python3",
	"node",
	"bash",
	"sh",
	"os.remove",
	"os.unlink",
]);

/**
 * Distinctive path-like tokens of a subject: anything holding a `/` or a dot
 * extension, plus that token's basename so a later call spelled with a
 * different prefix (`./scripts/x.sh`, an absolute path, a `cd` into the folder)
 * still matches. Short and generic tokens are dropped — a 3-character token
 * matches by accident far more often than on purpose.
 */
export function pathTokens(subject: string): string[] {
	const tokens = new Set<string>();
	for (const raw of subject.split(SEPARATORS)) {
		// A leading `./` or `../` carries no identity and would let a 3-character
		// name past the length floor; it is also how the same file gets spelled two
		// ways, so stripping it makes the tokens match across spellings.
		const word = raw
			.replace(/^[=:+*-]+/, "")
			.replace(/^(?:\.\.?\/)+/, "")
			.replace(/[.,:;=]+$/, "");
		if (word.length < 5) continue;
		if (NOISE.has(word.toLowerCase())) continue;
		const looksLikePath = word.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(word);
		if (!looksLikePath) continue;
		tokens.add(word);
		const base = word.slice(word.lastIndexOf("/") + 1);
		if (base.length >= 5 && !NOISE.has(base.toLowerCase())) tokens.add(base);
	}
	return [...tokens];
}

/** What a later call is, for the purposes of the rule's reach. */
export interface CircumventionCheck {
	/** Normalized tool name (`bash`, `write`, `edit`, `notebook_edit`, `read`, …). */
	toolName: string;
	/** The call's subject: the command for bash, the path for a file tool. */
	subject: string;
	/** Tokens from calls a rule refused this session (see {@link pathTokens}). */
	deniedTokens: readonly string[];
	/** True when the shell pre-gate proved this command read-only ("safe"). */
	readOnly: boolean;
	/** True when the tool writes a file (`isWritingTool`). */
	writesFile: boolean;
}

/**
 * The denied token this call would reach, or undefined when the rule does not
 * apply. A provably read-only command is always undefined, and so is any tool
 * that neither runs a shell nor writes a file.
 */
export function circumventsDeniedRule({ toolName, subject, deniedTokens, readOnly, writesFile }: CircumventionCheck): string | undefined {
	if (readOnly) return undefined;
	if (toolName !== "bash" && !writesFile) return undefined;
	return deniedTokens.find((token) => subject.includes(token));
}
