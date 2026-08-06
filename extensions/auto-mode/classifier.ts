/**
 * The classifier call itself — the one file here that talks to a provider.
 *
 * A one-shot `completeSimple` rather than an agent session: the classifier gets
 * no tools, no session, and no history beyond the user messages it is handed, so
 * there is nothing for it to be talked into doing. Its only output is a verdict.
 *
 * Model selection prefers a small fast model (Claude Code uses a Sonnet-class
 * model for this), overridable with `autoMode.classifierModel`, falling back to
 * the session's own model so auto mode still works on a single-model setup.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AutoModeConfig } from "./config.ts";
import { buildClassifierPrompt, type ClassifyRequest, type ClassifyVerdict, parseVerdict } from "./prompt.ts";
import { indexRules } from "./rules.ts";

/** A slow classifier stalls every tool call, so the wait is capped. */
export const CLASSIFIER_TIMEOUT_MS = 30_000;

/**
 * Preference order for an unconfigured classifier model: cheap and fast first,
 * since this runs on every non-fast-pathed tool call.
 */
const MODEL_PREFERENCES = [/haiku/i, /sonnet/i, /flash/i, /mini/i, /small/i];

export function pickClassifierModel(
	registry: ModelRegistry,
	sessionModel: Model<Api> | undefined,
	configured: string | undefined,
): Model<Api> | undefined {
	const available = registry.getAvailable();

	if (configured) {
		const [provider, ...rest] = configured.split("/");
		const modelId = rest.join("/");
		const exact = modelId ? registry.find(provider, modelId) : undefined;
		if (exact) return exact;
		// Also accept a bare model id, matching however the user wrote it.
		const byId = available.find((model) => model.id === configured || `${model.provider}/${model.id}` === configured);
		if (byId) return byId;
	}

	// Prefer a fast model from the session's own provider, so auto mode uses
	// credentials that are already working.
	const sameProvider = sessionModel ? available.filter((model) => model.provider === sessionModel.provider) : [];
	for (const candidates of [sameProvider, available]) {
		for (const pattern of MODEL_PREFERENCES) {
			const match = candidates.find((model) => pattern.test(model.id));
			if (match) return match;
		}
	}

	return sessionModel ?? available[0];
}

export interface ClassifierDeps {
	registry: ModelRegistry;
	sessionModel: Model<Api> | undefined;
	config: AutoModeConfig;
	signal?: AbortSignal;
}

/**
 * Ask the classifier about one tool call. Every failure path — no model, no
 * credentials, timeout, provider error, unparseable reply — returns a block.
 * An approval gate that cannot reach its classifier has not approved anything.
 */
export async function classify(request: ClassifyRequest, deps: ClassifierDeps): Promise<ClassifyVerdict> {
	const model = pickClassifierModel(deps.registry, deps.sessionModel, deps.config.classifierModel);
	if (!model) {
		return { decision: "block", reason: "No model is available to run the auto-mode classifier.", tier: "unmatched" };
	}

	const auth = await deps.registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { decision: "block", reason: `Auto-mode classifier has no credentials for ${model.provider}.`, tier: "unmatched" };
	}

	const index = indexRules(deps.config);
	const { system, user } = buildClassifierPrompt(request, deps.config, index);
	const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
	const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;

	// Some pi builds resolve a per-provider baseUrl alongside the key; it is not
	// in every published version of the auth type, so it is read defensively.
	const baseUrl = (auth as { baseUrl?: string }).baseUrl;

	try {
		const reply = await completeSimple(
			baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model,
			{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				// A verdict is one JSON object, so the cap stays small.
				maxTokens: 512,
				// `reasoning` is deliberately omitted: pi turns thinking off entirely
				// when it is absent, which is what a classifier wants (fast, cheap,
				// deterministic). Passing even "minimal" enables thinking, and the
				// resulting budget is derived from maxTokens — at 512 that lands under
				// Anthropic's 1024-token floor and every request 400s, which the gate
				// then correctly but uselessly reports as a block.
				temperature: 0,
			},
		);

		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return {
				decision: "block",
				reason: `Auto-mode classifier could not be reached (${reply.errorMessage ?? reply.stopReason}).`,
				tier: "unmatched",
			};
		}

		const text = reply.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		const verdict = parseVerdict(text, index, request.userMessages);
		// Allows carry no reason, so without this the permissive direction is
		// invisible — which is the harder one to notice and the more costly one to
		// get wrong. `CC_AUTO_MODE_DEBUG=1` puts the raw reply on stderr.
		if (process.env.CC_AUTO_MODE_DEBUG === "1") {
			process.stderr.write(
				`[auto-mode] ${request.toolName} → ${verdict.decision}${verdict.ruleId ? ` (${verdict.ruleId})` : ""}\n  raw: ${text.replace(/\s+/g, " ").slice(0, 600)}\n`,
			);
		}
		return verdict;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { decision: "block", reason: `Auto-mode classifier failed: ${message}`, tier: "unmatched" };
	}
}
