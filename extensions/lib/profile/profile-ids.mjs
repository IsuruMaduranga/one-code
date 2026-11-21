/**
 * The brand's profile ids (`profiles`, `defaultProfile`) and the rule they
 * follow, in a module with no side effects: `brand.mjs` reads the package's
 * own brand when it is imported, and scripts/lib/profile-folder.mjs checks
 * another product's brand with the same rule before it builds a path from
 * the id.
 */

/** A profile's name, a product's or a user's: it is a folder name and a launch flag. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Launch flags a product profile's id must not take: `--<id>` chooses the
 * profile and is taken out of the arguments, so an id spelled like one of
 * pi's or the harness's own flags would hide that flag.
 */
const RESERVED_FLAGS = new Set([
	"profile", "help", "version", "print", "mode", "continue", "resume", "session", "session-dir", "fork", "no-session",
	"model", "models", "provider", "api-key", "thinking", "tools", "no-tools", "extension", "no-extensions", "skill", "no-skills",
	"theme", "no-themes", "prompt-template", "no-prompt-templates", "system-prompt", "append-system-prompt", "export", "list-models",
	"offline", "verbose", "approve", "no-approve", "tui-mode", "permission-mode", "add-dir", "dangerously-skip-permissions",
]);

/** What is wrong with a brand's `profiles` and `defaultProfile`, one sentence per problem; empty when nothing is. */
export function profileIdProblems(value) {
	const problems = [];
	if (value.profiles !== undefined) {
		if (!Array.isArray(value.profiles) || value.profiles.some((id) => typeof id !== "string" || !PROFILE_NAME.test(id))) problems.push(`"profiles" must be an array of profile ids (letters, digits, ".", "_", "-")`);
		else if (new Set(value.profiles.map((id) => id.toLowerCase())).size !== value.profiles.length) problems.push(`"profiles" names an id twice (ids compare without case)`);
		else {
			const taken = value.profiles.filter((id) => RESERVED_FLAGS.has(id.toLowerCase()));
			if (taken.length > 0) problems.push(`"profiles" must not use ${taken.map((id) => `"${id}"`).join(", ")}: \`--${taken[0]}\` is already a launch flag`);
		}
	}
	// Spelled as the list spells it: the id names a folder, and folder names are case-sensitive on Linux.
	if (value.defaultProfile !== undefined && (typeof value.defaultProfile !== "string" || !Array.isArray(value.profiles) || !value.profiles.includes(value.defaultProfile))) problems.push(`"defaultProfile" must be one of the ids in "profiles", spelled as the list spells it`);
	return problems;
}
