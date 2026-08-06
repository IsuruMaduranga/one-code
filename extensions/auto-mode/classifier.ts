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
import {
	type Candidate,
	classifierCandidates,
	describeCandidate,
	isModelUnavailableError,
} from "./model-select.ts";
import { indexRules } from "./rules.ts";

/** A slow classifier stalls every tool call, so the wait is capped. */
export const CLASSIFIER_TIMEOUT_MS = 30_000;

/**
 * Which model the classifier settled on, and which candidates turned out to be
 * unusable. Owned by the caller so this module stays stateless, and so the
 * choice is *pinned*: re-resolving per call would let a registry refresh swap
 * classifiers mid-session, and would re-try a model already known to be dead.
 */
export interface ClassifierState {
	pinned?: Model<Api>;
	/** `provider/id` of candidates that failed as unusable. */
	rejected: Set<string>;
	/** Notices already delivered, so a per-call warning is not repeated per call. */
	notified: Set<string>;
}

export function createClassifierState(): ClassifierState {
	return { rejected: new Set(), notified: new Set() };
}

export interface ClassifierDeps {
	registry: ModelRegistry;
	sessionModel: Model<Api> | undefined;
	config: AutoModeConfig;
	signal?: AbortSignal;
	state: ClassifierState;
	/** Tell the user something once — which model is in use, or that theirs is dead. */
	onNotice?: (message: string, level: "info" | "warning") => void;
}

/** The candidate chain, minus anything already found unusable this session. */
function remainingCandidates(deps: ClassifierDeps): Candidate[] {
	const all = classifierCandidates({
		available: deps.registry.getAvailable(),
		sessionModel: deps.sessionModel,
		configured: deps.config.classifierModel,
	});
	const usable = all.filter((entry) => !deps.state.rejected.has(`${entry.model.provider}/${entry.model.id}`));
	// If everything has been rejected, the session model is still worth one more
	// attempt: a gate that stops asking has stopped gating.
	return usable.length > 0 ? usable : all.slice(-1);
}

function notifyOnce(deps: ClassifierDeps, key: string, message: string, level: "info" | "warning") {
	if (deps.state.notified.has(key)) return;
	deps.state.notified.add(key);
	deps.onNotice?.(message, level);
}

/**
 * Ask the classifier about one tool call. Every failure path — no model, no
 * credentials, timeout, provider error, unparseable reply — returns a block.
 * An approval gate that cannot reach its classifier has not approved anything.
 */
export async function classify(request: ClassifyRequest, deps: ClassifierDeps): Promise<ClassifyVerdict> {
	const candidates = remainingCandidates(deps);
	if (candidates.length === 0) {
		return { decision: "block", reason: "No model is available to run the auto-mode classifier.", tier: "unmatched" };
	}

	// A configured model that matches nothing available would otherwise fall
	// through in silence, leaving the user believing their setting is in force
	// while something else screens their calls.
	const configured = deps.config.classifierModel;
	if (configured && !candidates.some((entry) => entry.source === "configured")) {
		notifyOnce(
			deps,
			`unresolved:${configured}`,
			`autoMode.classifierModel is set to "${configured}", which is not an available model — check the name and that its provider is authenticated. Auto mode is using ${describeCandidate(candidates[0])} instead.`,
			"warning",
		);
	}

	const index = indexRules(deps.config);
	const { system, user } = buildClassifierPrompt(request, deps.config, index);

	// A model already pinned this session is used as-is; otherwise walk the chain,
	// stepping over anything that turns out to be unusable on this account.
	const attempts = deps.state.pinned
		? [{ model: deps.state.pinned, source: "session" as const }]
		: candidates;

	let lastError = "";
	for (const candidate of attempts) {
		const model = candidate.model;
		const key = `${model.provider}/${model.id}`;

		const auth = await deps.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			deps.state.rejected.add(key);
			lastError = auth.error;
			continue;
		}

		const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
		const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
		// Some pi builds resolve a per-provider baseUrl alongside the key; it is not
		// in every published version of the auth type, so it is read defensively.
		const baseUrl = (auth as { baseUrl?: string }).baseUrl;

		let failure: string | undefined;
		try {
			const reply = await completeSimple(
				baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model,
				{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal,
					...(process.env.CC_AUTO_MODE_DEBUG === "2"
						? {
								onPayload: (payload: unknown) => {
									const body = payload as { system?: Array<Record<string, unknown>> };
									const blocks = (body.system ?? []).map(
										(b) =>
											`{keys=${Object.keys(b).join(",")} textLen=${String((b as { text?: string }).text ?? "").length} cache=${JSON.stringify((b as { cache_control?: unknown }).cache_control)}}`,
									);
									process.stderr.write(`[auto-mode payload] systemBlocks=${blocks.join(" ")}\n`);
									return undefined;
								},
							}
						: {}),
					// A verdict is one JSON object, so the cap stays small.
					maxTokens: 512,
					// `reasoning` is deliberately omitted: pi turns thinking off entirely
					// when it is absent, which is what a classifier wants (fast, cheap,
					// deterministic). Passing even "minimal" enables thinking, and the
					// resulting budget is derived from maxTokens — at 512 that lands under
					// Anthropic's 1024-token floor and every request 400s, which the gate
					// then correctly but uselessly reports as a block.
					//
					// `temperature` is likewise NOT passed. It looks free — a classifier
					// wants determinism — but it is deprecated on Claude Sonnet 5 and
					// unsupported on Opus 4.7+, and pi's compat data still advertises it,
					// so the request 400s and the gate blocks every single call. Several
					// OpenAI reasoning models reject it too. A gate that must work across
					// 38 providers cannot afford an option that fails closed on some of
					// them for a property it does not need.
					cacheRetention: "long",
				},
			);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				failure = reply.errorMessage ?? reply.stopReason;
			} else {
				const text = reply.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("");
				const verdict = parseVerdict(text, index, request.userMessages);

				// Pin on the first success, so the classifier cannot change under the
				// session and a working model is not re-litigated per call.
				if (!deps.state.pinned) {
					deps.state.pinned = model;
					notifyOnce(deps, `using:${key}`, `Auto mode is screening calls with ${describeCandidate(candidate)}.`, "info");
				}

				// Allows carry no reason, so without this the permissive direction is
				// invisible — which is the harder one to notice and the more costly one
				// to get wrong. `CC_AUTO_MODE_DEBUG=1` puts the raw reply on stderr.
				if (process.env.CC_AUTO_MODE_DEBUG) {
					const u = reply.usage as
						| { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: unknown }
						| undefined;
					const cost = u?.cost;
					const spend =
						cost && typeof cost === "object"
							? Object.entries(cost as Record<string, unknown>)
									.filter(([, value]) => typeof value === "number" && value > 0)
									.map(([name, value]) => `${name}=$${(value as number).toFixed(6)}`)
									.join(" ")
							: "";
					process.stderr.write(
						`[auto-mode] ${key} ${request.toolName} → ${verdict.decision}${verdict.ruleId ? ` (${verdict.ruleId})` : ""}\n` +
							`  usage: in=${u?.input ?? "?"} out=${u?.output ?? "?"} cacheRead=${u?.cacheRead ?? 0} cacheWrite=${u?.cacheWrite ?? 0} ${spend}\n` +
							`  raw: ${text.replace(/\s+/g, " ").slice(0, 400)}\n`,
					);
				}
				return verdict;
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}

		lastError = failure ?? "unknown error";
		// A model that is simply not usable here is worth stepping over. A transient
		// failure is not: switching models would paper over something about to clear,
		// so that surfaces as a block and the same model is tried again next call.
		if (!isModelUnavailableError(lastError)) {
			return {
				decision: "block",
				reason: `Auto-mode classifier could not be reached (${lastError}).`,
				tier: "unmatched",
			};
		}

		deps.state.rejected.add(key);
		const isConfigured = candidate.source === "configured";
		notifyOnce(
			deps,
			`rejected:${key}`,
			isConfigured
				? `Auto mode cannot use ${key} from autoMode.classifierModel (${lastError}). Set a different model in ~/.claude/settings.json.`
				: `Auto mode cannot use ${key} as its classifier (${lastError}); trying another model. Set autoMode.classifierModel in ~/.claude/settings.json to choose one.`,
			"warning",
		);
	}

	// Every candidate was unusable — say which knob fixes it rather than leaving
	// the user with a gate that blocks everything for no stated reason.
	return {
		decision: "block",
		reason: `No usable auto-mode classifier model (last error: ${lastError}). Set autoMode.classifierModel in ~/.claude/settings.json.`,
		tier: "unmatched",
	};
}
