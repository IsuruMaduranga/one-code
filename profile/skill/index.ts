/**
 * One Code's skill text (the profile's `text.skill`): the skill tool, its
 * results, and the skills listing's framing (Claude Code's header).
 */

import type { SkillText } from "../../extensions/skill/text.ts";

const listed = (listing: string | undefined) => listing ?? "(no skills available)";

export const skill: SkillText = {
	description:
		"Invoke a skill.\n\nA skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (`/<name>`, or \"slash command\"); that's a request to invoke it.\n\n- `skill`: exact name from the listing, no leading slash. Plugin skills are named `<plugin>:<skill>`.\n- `args`: optional arguments to pass through.\n\nOnly names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (`/help`, `/clear`, …) aren't skills. Use `list` to see what is available.",
	promptSnippet: "Load packaged instructions for a task (see the skills listing)",
	params: {
		skill: "Exact skill name, no leading slash",
		args: "Arguments to pass through to the skill",
		list: "List available skills instead of invoking one",
	},
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
