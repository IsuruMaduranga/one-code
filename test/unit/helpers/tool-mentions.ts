/**
 * Shared by the tests that check text naming another tool follows the live
 * tool set: the cases (each optional feature's tools off, and edit) and the
 * search for a tool's name outside the English phrases that share it.
 */
import { TOOL_FEATURES } from "../../../extensions/lib/profile/features.ts";
import type { LiveTools } from "../../../extensions/lib/profile/live-tools.ts";

/** A text that may name another tool: its label, the feature that owns it (its own tools may name each other), and the text. */
export type NamedText = [label: string, owner: string | undefined, text: string];

/** Phrases where a tool's name is an English word, not the tool, by tool. */
export type EnglishPhrases = Readonly<Record<string, readonly RegExp[]>>;

/** The places `text` still names `tool`, outside the English phrases. */
export function mentions(text: string, tool: string, english: EnglishPhrases): string[] {
	let rest = text;
	for (const phrase of english[tool] ?? []) rest = rest.replace(new RegExp(phrase.source, `${phrase.flags.replace("g", "")}g`), "");
	const found: string[] = [];
	const rx = new RegExp(`(^|[^A-Za-z_-])${tool}([^A-Za-z_-]|$)`, "g");
	for (const match of rest.matchAll(rx)) found.push(rest.slice(Math.max(0, match.index - 50), match.index + tool.length + 40).replace(/\n/g, "⏎"));
	return found;
}

/**
 * Every text of `texts(live)` that names a tool the session lacks, with each
 * optional feature's tools off in turn, and edit. powershell is left out: a
 * text names it only from the session's own tool list.
 */
export function toolLeaks(texts: (live: LiveTools) => NamedText[], english: EnglishPhrases): string[] {
	const leaks: string[] = [];
	const cases: { feature: string; off: string[] }[] = [...new Set<string>(Object.values(TOOL_FEATURES))]
		.filter((feature) => feature !== "powershell")
		.map((feature) => ({ feature, off: Object.keys(TOOL_FEATURES).filter((tool) => TOOL_FEATURES[tool] === feature) }));
	cases.push({ feature: "edit", off: ["edit"] });
	for (const { feature, off } of cases) {
		const live: LiveTools = { has: (name) => !off.includes(name) };
		for (const [label, owner, text] of texts(live)) {
			if (owner === feature) continue;
			for (const tool of off) for (const where of mentions(text, tool, english)) leaks.push(`${tool} off, ${label}: …${where}…`);
		}
	}
	return leaks;
}
