/**
 * Which model each role runs on, and why (pure).
 *
 * The doctor does not re-decide anything: it calls the SAME resolvers the
 * session uses — `resolveSubagentModel` for delegated work, `classifierCandidates`
 * for auto mode's screener, `pickEconomicalContainedModel` for the web-fetch /
 * recap reader, `resolveModelTier` for the prompt register — and reports their
 * answers next to their sources. A user who asks "why did my subagent run on
 * Haiku?" gets the resolver's own notice, not a paraphrase.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { loadAutoModeConfig } from "../auto-mode/config.ts";
import { classifierCandidates, describeCandidate, type ClassifierNotice } from "../auto-mode/model-select.ts";
import { modelSpec, pricedInput } from "../lib/model-policy.ts";
import { intrinsicTier, pickEconomicalContainedModel, type PromptTier, resolveModelTier, tierOverride } from "../lib/model-tier.ts";
import { applicableSubagentDefault, loadSubagentDefault, type SubagentDefault } from "../subagents/default-model.ts";
import { resolveSubagentModel, type SubagentModelResolution } from "../subagents/model-select.ts";
import { contextLabel, type Finding, priceLabel, type ReportLine, type ReportSection, type SessionView } from "./report.ts";

export interface ModelFacts {
	session?: Model<Api>;
	sessionTier?: PromptTier;
	/** The register the system prompt is built in — the tier, or a CC_PROMPT_TIER override. */
	promptTier: PromptTier;
	promptTierForced: boolean;
	subagent: SubagentModelResolution;
	subagentConfigured?: SubagentDefault;
	/** The configured default exists but does not apply to this session (Claude Code's env var on a non-Claude model). */
	subagentConfiguredInapplicable: boolean;
	classifier: { model?: Model<Api>; description?: string; notices: ClassifierNotice[]; configured?: string };
	reader?: { model: Model<Api>; via: "tier" | "session" };
}

export const TIER_LABEL: Record<PromptTier, string> = {
	frontier: "frontier tier — terse Claude Code prompt",
	workhorse: "workhorse tier — full Claude Code prompt",
	cheap: "cheap tier — full prompt, Haiku register",
	tiny: "tiny tier — full prompt plus weak-model scaffolding and grep/find/ls",
};

export function collectModelFacts(available: Model<Api>[], session: SessionView, home: string, env: NodeJS.ProcessEnv): ModelFacts {
	const sessionModel = session.model;
	const configuredAll = loadSubagentDefault(home, env);
	const configured = applicableSubagentDefault(configuredAll, sessionModel);
	const subagent = resolveSubagentModel({ configuredDefault: configured, sessionModel, available });
	const autoConfig = loadAutoModeConfig(home);
	const chain = classifierCandidates({
		available,
		sessionModel,
		configured: autoConfig.classifierModel,
		configuredSetForContainment: autoConfig.classifierModelSetFor,
	});
	const first = chain.candidates[0];
	const reader = pickEconomicalContainedModel(available, sessionModel);
	return {
		session: sessionModel,
		sessionTier: sessionModel ? intrinsicTier(sessionModel) : undefined,
		promptTier: resolveModelTier(sessionModel, env),
		promptTierForced: tierOverride(env) !== undefined,
		subagent,
		subagentConfigured: configuredAll,
		subagentConfiguredInapplicable: configuredAll !== undefined && configured === undefined,
		classifier: {
			model: first?.model,
			description: first ? describeCandidate(first) : undefined,
			notices: chain.notices,
			configured: autoConfig.classifierModel,
		},
		reader,
	};
}

const SUBAGENT_SOURCE: Record<SubagentModelResolution["source"], string> = {
	call: "named per call",
	agent: "from the agent file",
	default: "the configured default",
	automatic: "automatic: cheapest capable model on this provider, cheaper than the main model",
	session: "the main model — nothing cheaper and capable on this provider",
};

export function modelsSection(facts: ModelFacts, session: SessionView, findings: Finding[]): ReportSection {
	const lines: ReportLine[] = [];
	const { session: main } = facts;

	if (!main) {
		lines.push({
			text: "Main: none — no model is available, so a session cannot start work yet",
			level: "error",
		});
		return { title: "Models", lines };
	}

	const sourceNote =
		session.modelSource === "session"
			? "this session"
			: session.modelSource === "default-setting"
				? "saved default; the next start uses it"
				: session.modelSource === "first-available"
					? "no saved default — pi picks the first available model at startup"
					: "";
	const details = [priceLabel(main), contextLabel(main.contextWindow), sourceNote].filter(Boolean).join(" · ");
	lines.push({ text: `Main: ${modelSpec(main)} — ${details}`, level: "ok" });
	lines.push({
		text: `Prompt register: ${TIER_LABEL[facts.promptTier]}${facts.promptTierForced ? " (forced by CC_PROMPT_TIER)" : ""}`,
		indent: 1,
		level: "dim",
	});
	if (session.thinkingLevel) lines.push({ text: `Effort: ${session.thinkingLevel} (/effort or shift+tab to change)`, indent: 1, level: "dim" });

	const sub = facts.subagent;
	if (sub.model) {
		lines.push({ text: `Subagents and workflow agents: ${modelSpec(sub.model)} — ${SUBAGENT_SOURCE[sub.source]}`, level: "ok" });
		if (facts.subagentConfigured) {
			const knob = facts.subagentConfigured.source === "subagentModel setting" ? "subagentModel in ~/.onecode/settings.json" : "CLAUDE_CODE_SUBAGENT_MODEL";
			lines.push({
				text: `Setting: "${facts.subagentConfigured.spec}" via ${knob}${facts.subagentConfiguredInapplicable ? " — not applied: Claude Code's knob applies only when the main model is a Claude model" : ""}`,
				indent: 1,
				level: facts.subagentConfiguredInapplicable ? "warn" : "dim",
			});
		}
		for (const notice of sub.notices) {
			lines.push({ text: notice, indent: 1, level: "warn" });
			findings.push({ level: "warn", text: `Subagent model: ${notice}`, fix: "Re-set the default with /subagent on this session, or /subagent clear." });
		}
	} else {
		lines.push({ text: "Subagents: no model resolves", level: "error" });
	}

	const classifier = facts.classifier;
	if (classifier.model) {
		const live = session.permission?.classifier;
		const pinned = session.permission?.pinned && live ? ` — screening this session on ${live}` : "";
		lines.push({ text: `Auto-mode classifier: ${classifier.description ?? modelSpec(classifier.model)}${pinned}`, level: "ok" });
	} else {
		lines.push({ text: "Auto-mode classifier: none — auto mode stays out of the mode cycle until a model is available", level: "warn" });
	}
	for (const notice of classifier.notices) {
		lines.push({ text: notice.text, indent: 1, level: notice.level === "warning" ? "warn" : "dim" });
		if (notice.level === "warning") {
			findings.push({ level: "warn", text: `Classifier: ${notice.text}`, fix: "Pick a model with /auto-mode model, or /auto-mode model clear for the automatic choice." });
		}
	}

	if (facts.reader) {
		lines.push({
			text: `Web-fetch and recap reader: ${modelSpec(facts.reader.model)} — ${facts.reader.via === "tier" ? "cheapest capable model on this provider" : "the main model"}`,
			level: "dim",
		});
	}

	if (session.permission) {
		const mode = session.permission.mode;
		const from = session.permission.source ? ` (${session.permission.source})` : "";
		lines.push({ text: `Permission mode: ${mode}${from} — ctrl+q cycles, /permissions lists the rules`, level: "dim" });
	}

	if (facts.sessionTier === "tiny") {
		findings.push({
			level: "warn",
			text: `${modelSpec(main)} is classed as a tiny-tier model: One Code adds weak-model scaffolding and search tools, and never auto-selects a tiny model for subagents or the classifier.`,
			fix: "For coding work pick a cheap- or workhorse-tier model with /model; see /doctor presets.",
		});
	}
	if (pricedInput(main) === undefined) {
		lines.push({
			text: "This model carries no price in the catalog, so automatic cost-based choices (cheaper subagents, a cheaper classifier) fall back to the main model.",
			indent: 1,
			level: "dim",
		});
	}
	return { title: "Models", lines };
}
