/**
 * What the skill tool and the skills listing need from a profile (types only;
 * working-docs/features/profiles/). The listing's lines, the `$ARGUMENTS`
 * substitution, the command breadcrumb and the skill's base-directory line
 * are the skill format, shared by every product, and stay in the base.
 */

export interface SkillText {
	description: string;
	/** The tool's line in the system prompt's tool list. */
	promptSnippet: string;
	params: Record<"skill" | "args" | "list", string>;
	/** The header over the listing on the first user message (and later additions). */
	listingHeader: string;
	/** The listing for a session without the skill tool: each skill's file, to read with `reader`. */
	readableListing(p: { lines: readonly string[]; reader: "read" | "shell" }): string;
	/** `listing` is undefined when no skill is listable. */
	available(listing: string | undefined): string;
	/** A call that passed `args` but no `skill`. */
	noName(listing: string | undefined): string;
	notFound(p: { query: string; listing: string | undefined }): string;
	/** A bare name several plugins ship. */
	ambiguous(p: { query: string; wanted: string; matches: readonly string[] }): string;
	/** `manager`: the command where the user turns it back on (`/skills`, `/plugins`). */
	off(p: { name: string; manager: string }): string;
	userOnly(name: string): string;
	/** A skill marked `disable-model-invocation`, as the model named it. */
	manualOnly(name: string): string;
	readFailed(p: { name: string; osMessage: string }): string;
	/** The result's first block; the skill's text follows as the second. */
	launching(name: string): string;
	/** Around a skill's text when it takes arguments (`hint`) and the call passed none. */
	missingArguments(hint: string): { before: string; after: string };
}
