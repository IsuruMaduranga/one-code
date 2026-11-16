/**
 * Shared by the tests that check text naming another tool follows the live
 * tool set: the cases (each optional feature's tools off, and edit) and the
 * search for a tool's name outside the English phrases that share it; and
 * the check that a system-prompt section stays put when a deferred tool loads.
 */
import { FEATURE_IDS, TOOL_FEATURES, toolSetProblems } from "../../../extensions/lib/profile/features.ts";
import { PINNED_TOOLS } from "../../../extensions/lib/profile/profile.ts";
import type { LiveFeatures, LiveTools } from "../../../extensions/lib/profile/live-tools.ts";
import { PROMPT_TIERS } from "../../../extensions/lib/models/model-tier.ts";
import { DEFERRABLE_TOOLS } from "../../../extensions/lib/request/deferrable-tools.ts";
import type { SectionSession } from "../../../extensions/request/system-prompt/text.ts";

/**
 * A text that may name another tool: its label, the feature that owns it
 * (with the whole feature off the text is not sent), the text, and the tool
 * whose own words it is (a description or a parameter: not sent when that
 * one tool is off).
 */
export type NamedText = [label: string, owner: string | undefined, text: string, tool?: string];

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

/** Tools pi's `--exclude-tools` takes out alone while their feature's other tools stay: Agent and SendMessage, each leaving the other and list_agents behind. */
const FLAG_ALONE: ReadonlySet<string> = new Set(["Agent", "SendMessage"]);

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
	// One tool off while its feature stays on: its siblings' texts are still sent.
	const everyFeature = new Set(FEATURE_IDS);
	for (const off of Object.keys(TOOL_FEATURES)) {
		// A tool a profile cannot turn off alone is no case, unless pi's --exclude-tools takes it out alone (lib/profile/pi-tool-flags.ts).
		if (!FLAG_ALONE.has(off) && (off === "powershell" || PINNED_TOOLS.has(off) || toolSetProblems(everyFeature, new Set([off])).length > 0)) continue;
		const live: LiveTools = { has: (name) => name !== off };
		for (const [label, , text, tool] of texts(live)) {
			if (tool === off) continue;
			for (const where of mentions(text, off, english)) leaks.push(`${off} alone off, ${label}: …${where}…`);
		}
	}
	return leaks;
}

/**
 * The passages no text of `texts` has: each is a silent no-op, left by a
 * reworded sentence. Only the tables `texts` renders through are heard.
 */
export function stalePassages(texts: (live: LiveTools) => NamedText[]): string[] {
	const seen = new Map<string, boolean>();
	const watch = (passage: string, found: boolean) => void seen.set(passage, found || seen.get(passage) === true);
	// Every tool on, then every tool off: a passage may be what another tool's replacement leaves.
	texts({ has: () => true, watch });
	texts({ has: () => false, watch });
	return [...seen].filter(([, found]) => !found).map(([passage]) => passage);
}

/** Every base tool; a session starts with the ones nobody defers. */
const BASE_TOOLS: readonly string[] = [...new Set(["read", "bash", "edit", "write", ...Object.keys(TOOL_FEATURES)])];

/**
 * Where a system-prompt section's bytes move inside a session, on every
 * tier, with and without the task tools. Rendered with the session's
 * starting tools, then with each deferrable tool added (and all of them at
 * once), the bytes must be the same: a loaded tool joins pi's active list
 * (`tools`), and a prompt that follows it misses the cache from the top,
 * while passages keyed on `live` or `features` never move. A second render
 * of the same session must match the first, so a section that reads the
 * clock, a counter or a file shows up too. `deferred` names the tools the
 * caller defers itself (a product's own tool over DEFER_CHANNEL), loaded
 * like the base's; `live` and `features` default to everything on. Empty
 * when the section is stable.
 */
export function deferralChanges(
	render: (session: SectionSession) => string | undefined,
	{ live = { has: () => true }, features = { has: () => true }, deferred = [] }: { live?: LiveTools; features?: LiveFeatures; deferred?: readonly string[] } = {},
): string[] {
	const changes: string[] = [];
	const deferrable = [...new Set([...DEFERRABLE_TOOLS, ...deferred])];
	// A base tool the caller defers starts unloaded too.
	const eager = BASE_TOOLS.filter((tool) => !deferrable.includes(tool));
	for (const tier of PROMPT_TIERS) {
		for (const taskTools of [true, false]) {
			const label = `${tier}${taskTools ? "" : " without task tools"}`;
			const at = (tools: readonly string[]) => render({ tier, taskTools, tools, live, features });
			const start = at(eager);
			if (at(eager) !== start) changes.push(`${label}: a second render differs`);
			for (const loaded of [...deferrable.map((tool) => [tool]), deferrable]) {
				if (at([...eager, ...loaded]) !== start) changes.push(`${label}: ${loaded.length === 1 ? loaded[0] : "every deferrable tool"} loaded`);
			}
		}
	}
	return changes;
}
