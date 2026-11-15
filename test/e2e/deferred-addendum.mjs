/**
 * Reading the deferred-tools addendum out of a captured request, for the probe
 * checkers (cache-probe.mjs, transition-check.mjs). The addendum
 * (lib/request/deferred.ts deferredAddendumText) is its head line, then one
 * line per tool: the name alone or `name: hint`. It rides a user message or a
 * tool result, inside a system-reminder.
 */

/** The start of the addendum's head line (lib/request/tool-search-text.ts addendumHead). */
export const ADDENDUM_START = "Additional deferred tools became available via tool_search";

/** A tool line: a name, then optionally a colon and the hint. */
const TOOL_LINE = /^[A-Za-z0-9_:-]+(?:: .*)?$/;

/**
 * A message content's text: a string, or an array of blocks whose `text` or
 * nested `content` (a tool result's string or block array) is read in turn.
 */
export const textOf = (content) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === "string" ? b.text : textOf(b?.content))).join("\n") : "";

/**
 * The tool lines of every addendum in `text`, trimmed: the lines after each
 * head line, blank ones skipped, up to the first line that is not a tool line.
 */
export function addendumLines(text) {
	const lines = [];
	for (let at = text.indexOf(ADDENDUM_START); at !== -1; at = text.indexOf(ADDENDUM_START, at + 1)) {
		for (const raw of text.slice(at).split("\n").slice(1)) {
			const line = raw.trim();
			if (!line) continue;
			if (!TOOL_LINE.test(line)) break;
			lines.push(line);
		}
	}
	return lines;
}

/** The tool a line of the addendum names: the line up to its hint. */
export const addendumToolName = (line) => {
	const at = line.indexOf(": ");
	return at === -1 ? line : line.slice(0, at);
};

/** How many times each tool name is announced as newly available (a tool_addition block or the deferred-tool addendum). */
export function announcements(messages) {
	const counts = new Map();
	const bump = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
	for (const message of messages) {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const additions = blocks.filter((block) => block?.type === "tool_addition").map((block) => block.tool?.name ?? block.name);
		for (const name of additions) if (typeof name === "string") bump(name);
		if (additions.length) continue;
		for (const line of addendumLines(textOf(message.content))) bump(addendumToolName(line));
	}
	return counts;
}
