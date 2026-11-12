/**
 * The skill tool's and the skills listing's words. The profile words the
 * tool itself (`SkillText`: description, prompt snippet, parameters); the
 * listing's header, the launch line and the refusals are here
 * (`skillResultText`). The listing's lines, the `$ARGUMENTS` substitution,
 * the command breadcrumb and the skill's base-directory line
 * (lib/plugins/skill-invoke.ts) are the skill format, shared by every
 * product.
 */

export interface SkillText {
	description: string;
	/** The tool's line in the system prompt's tool list. */
	promptSnippet: string;
	params: Record<"skill" | "args" | "list", string>;
}

/** The group's results, refusals and notes, which the base words (`skillResultText`). */
export interface SkillResultText {
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

const listed = (listing: string | undefined) => listing ?? "(no skills available)";

/** The base's words of the group. */
export const skillResultText: SkillResultText = {
	// Claude Code's framing of a skill with a folder.
	listingHeader: "The following skills are available for use with the Skill tool:",
	readableListing: ({ lines, reader }) =>
		`The following skills provide specialized instructions for specific tasks. Read a skill's file with ${reader === "read" ? "the read tool" : "the shell"} when the task matches its description:\n\n${lines.join("\n")}`,
	available: (listing) => `Available skills:\n${listed(listing)}`,
	noName: (listing) =>
		`No \`skill\` given, but you passed \`args\` — this looks like an invocation that forgot to name the skill. Set \`skill\` to one of the names below, or call with \`list: true\` to just browse.\n\nAvailable skills:\n${listed(listing)}`,
	notFound: ({ query, listing }) => `No skill named "${query}".\n\nAvailable skills:\n${listed(listing)}`,
	ambiguous: ({ query, wanted, matches }) => `"${query}" is ambiguous — it matches ${matches.join(", ")}. Use the full \`<plugin>:${wanted}\` name.`,
	off: ({ name, manager }) => `Skill "${name}" is turned off — the user can re-enable it from ${manager}.`,
	userOnly: (name) => `Skill "${name}" is set to user-only — only the user can run it, by typing /${name}.`,
	manualOnly: (name) => `Skill ${name} cannot be used with Skill tool due to disable-model-invocation`,
	readFailed: ({ name, osMessage }) => `Could not read skill "${name}": ${osMessage}`,
	launching: (name) => `Launching skill: ${name}`,
	/**
	 * A skill's text is its instructions, not a manual: a weak model "checking
	 * the interface" of `/loop` got the no-argument body, which starts an
	 * autonomous loop. A mild opening line lost to that body's "The user
	 * invoked /loop with no prompt" on DeepSeek V4.1 Flash; telling it to stop
	 * and check, plus a closing reminder, turned it around.
	 */
	missingArguments: (hint) => ({
		before: `Stop and check before following this. This skill takes arguments (${hint}) and this call passed none, so what follows is its no-argument mode, written as if the user asked for the skill with nothing after it. If the user's request names any of those arguments, do not follow the instructions below: call the skill again with them in \`args\`.`,
		after: "Reminder: those were the no-argument instructions. If the user's request included arguments, call the skill again with them in `args` instead of following them.",
	}),
};
