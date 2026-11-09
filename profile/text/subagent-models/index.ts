/**
 * One Code's subagent model text (the profile's `text.subagentModels`): the
 * notices a model resolution leaves, the expensive-model gate and the model
 * menu. One Code's own text; the aliases are Claude Code's tier names.
 */

import type { ChainSource, LiveTools, MenuLabel, SubagentModelNotice, SubagentModelSource, SubagentModelsText } from "../../../extensions/sdk/profile.ts";

/** Which choice a model came from, named for the reader. */
const SOURCE: Record<SubagentModelSource, string> = {
	call: "the model this call named",
	agent: "the agent's own model",
	default: "the configured default",
	automatic: "the automatic smaller default",
	session: "this session's model",
};

/** Where a chain entry was set. */
const KNOB: Record<ChainSource, string> = {
	call: "the model field",
	agent: "the agent file's model",
	default: "the configured subagent default",
};

const LABEL: Record<MenuLabel, string> = {
	automaticDefault: "the automatic smaller default",
	sessionDefault: "the default (this session's model)",
	configuredDefault: "the configured default",
	session: "this session's model",
	cheaper: "cheaper, same provider",
};

/** The tools whose `model` field the menu serves: workflow agents take one too, when workflows are on. */
const modelField = (live: LiveTools): string => (live.has("workflow") ? "subagent/workflow" : "subagent");

const price = (dollars: number | undefined): string => (dollars === undefined ? "" : ` ($${dollars}/M in)`);

// SCOPE the alias claims: "no sonnet model exists" is false at machine level
// whenever Anthropic is also authenticated, and a model relaying it tells the
// user "Sonnet is not available". What is true is narrower: the alias cannot
// leave this session's provider family.
const family = (session: string | undefined): string => (session ? ` (${session})` : "");

function notice(n: SubagentModelNotice): string {
	switch (n.kind) {
		case "aliasAsTier":
			return `No "${n.alias}" model in this session's provider family${family(n.session)}; read as its Claude Code tier, "${n.alias}" resolves to ${n.resolved} here.`;
		case "aliasMissing":
			return `No "${n.alias}" model in this session's provider family${family(n.session)}.`;
		case "textOnlyCall":
			return `Requested subagent model ${n.model} is text-only, but this session works with images or PDFs a subagent may need to read (the inherited transcript, or a file it opens). Pick an image-capable model.`;
		case "textOnly":
			return `${n.model} (from ${KNOB[n.source]}) is text-only, but this session works with images or PDFs a subagent may need to read; an image-capable same-provider model runs this subagent instead.`;
		case "agentOtherProvider":
			return `The agent file's model ${n.model} is a different provider than this session (${n.session}); on a non-Claude session subagents stay on this provider, so a same-provider model runs this subagent instead.`;
		case "staleDefault":
			return `The configured subagent default ${n.model} was set for a different provider than this session (${n.session}); a same-provider model runs this subagent instead. Re-set it with /subagent on this session to use it here.`;
		case "otherProviderHonored":
			return `Subagent model ${n.model} is a different provider/family than this session (${n.session}) — it was named via ${KNOB[n.source]}, so it is honored.`;
		case "callUnavailable":
			return `Requested subagent model "${n.wanted}" is not available — falling back to the agent's configured model or the session default.`;
		case "unavailable":
			return n.source === "agent"
				? `Subagent model "${n.wanted}" (from ${KNOB[n.source]}) is not available — falling back to the configured default, the automatic same-provider pick, or the session model.`
				: `Subagent model "${n.wanted}" (from ${KNOB[n.source]}) is not available — the automatic same-provider pick or the session model runs this subagent instead.`;
	}
}

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const subagentModelsText = (live: LiveTools): SubagentModelsText => ({
	notice,
	runsOn: ({ model, source }) => `This subagent runs on ${model} (${SOURCE[source]}).`,
	costsMore: ({ model, price: dollars, session, sessionPrice }) =>
		`Requested model ${model}${price(dollars)} costs more per input token than this session's model ${session}${price(sessionPrice)}.`,
	menuLine: ({ model, price: dollars, label }) => `- ${model}${price(dollars)} — ${LABEL[label]}`,
	// Informs rather than instructs: a dearer default can be deliberate (a cheap
	// driver with strong workers), and only a configured default can be dearer.
	defaultCostsMore: ({ price: dollars, sessionPrice }) =>
		`Note: the default subagent model${price(dollars)} costs more per input token than this session's model${price(sessionPrice)}. ` +
		"That may be deliberate, but for routine or mechanical tasks consider passing a cheaper listed model in the `model` field.",
	settingPinned: ({ model, otherProvider }) =>
		`The user pinned the subagent default to ${model} via the subagentModel setting; ` +
		"subagents run on it unless you pass a different model in the `model` field" +
		(otherProvider
			? ` — it is a different provider than this session (${otherProvider}), so a subagent's inherited transcript goes to that provider; pass a listed same-provider model to keep it here.`
			: "."),
	refused: ({ model, newDefault }) =>
		`Model ${model} is not usable on this account, so automatic selection skips it and the ${modelField(live)} \`model\` field should not name it. ` +
		`The subagent default is now ${newDefault ?? "this session's model"}.`,
	// Kept short: its tokens are paid on every request.
	menu: ({ lines, notes }) =>
		[
			`Models for the ${modelField(live)} \`model\` field (omit it to use the default; set the default with /subagent):`,
			...lines,
			...notes,
			"Aliases sonnet|opus|haiku|fable resolve within this session's provider — by name when a model carries it, else as the tier it names " +
				'(haiku: the cheapest capable model, sonnet: the cheapest workhorse-class model, opus/fable: this session\'s model); "inherit" means the session model. ' +
				"Any exact provider/model-id the user asked for also works, even from another provider (that is announced to the user) or unlisted here — this is a menu, not a whitelist.",
		].join("\n"),
});
