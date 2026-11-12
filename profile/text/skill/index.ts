/**
 * One Code's skill words (the profile's `text.skill`): the skill tool's
 * description, prompt snippet and parameters.
 */

import type { SkillText } from "../../../extensions/sdk/profile.ts";

export const skill: SkillText = {
	description:
		"Invoke a skill.\n\nA skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (`/<name>`, or \"slash command\"); that's a request to invoke it.\n\n- `skill`: exact name from the listing, no leading slash. Plugin skills are named `<plugin>:<skill>`.\n- `args`: optional arguments to pass through.\n\nOnly names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (`/help`, `/clear`, …) aren't skills. Use `list` to see what is available.",
	promptSnippet: "Load packaged instructions for a task (see the skills listing)",
	params: {
		skill: "Exact skill name, no leading slash",
		args: "Arguments to pass through to the skill",
		list: "List available skills instead of invoking one",
	},
};
