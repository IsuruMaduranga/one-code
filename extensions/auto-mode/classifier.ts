/**
 * The classifier call itself — the one file here that talks to a provider.
 *
 * Claude Code's two-stage formula, reproduced (docs/decisions/auto-mode.md, P4):
 *   Stage 1 grades HARM ONLY (maxTokens 64). severity < 50 → allow, no stage 2.
 *   Stage 2 applies intent + ALLOW (maxTokens 8192, <thinking> CoT) → severity +
 *   <category> (+ our verified <intent>). Both stages share one system prompt and
 *   transcript byte-for-byte, so stage 2 is a near-total cache hit off stage 1.
 *
 * A one-shot `completeSimple` per stage rather than an agent session: no tools,
 * no history beyond the transcript it is handed, nothing to be talked into. Every
 * failure path — no model, no credentials, timeout, provider error, truncated or
 * unparseable reply — returns a block; a gate that cannot reach its classifier
 * has approved nothing.
 */

import type { Model, Api, AssistantMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { forcedReasoningLevel, isReasoningMandatoryError, reasoningRetryLevel } from "../lib/model-policy.ts";
import type { AutoModeConfig } from "./config.ts";
import {
	buildPayload,
	type ClassifyRequest,
	type ClassifyVerdict,
	parseSeverity,
	parseStage2,
	reviewUser,
	SEVERITY_THRESHOLD,
	stage1User,
	stage2User,
} from "./prompt.ts";
import {
	type Candidate,
	type ClassifierNotice,
	classifierCandidates,
	describeCandidate,
	isModelUnavailableError,
	replyText,
	withAuthBaseUrl,
} from "./model-select.ts";

/** A slow classifier stalls every tool call, so the wait is capped per stage. */
export const CLASSIFIER_TIMEOUT_MS = 30_000;

/**
 * A pinned model that times out this many calls in a row is unpinned, so a model
 * that was fast when first chosen but has since fallen behind demand does not
 * stay the session's classifier forever. The next call re-runs selection.
 */
export const ROTATE_AFTER_TIMEOUTS = 2;

/**
 * Whether a failure is our own classifier timeout (or an equivalent abort/stall)
 * rather than a substantive provider error. A timeout is transient — worth a
 * retry and worth stepping to another candidate — where a 500 or a bad request
 * is not. A *user* cancel also aborts, so callers must rule that out first
 * (`deps.signal?.aborted`) before treating an abort as a timeout.
 */
export function isClassifierTimeout(message: string): boolean {
	return /\babort|\btimed?\s*out\b|\btimeout\b|\betimedout\b|\bdeadline\b/i.test(message);
}

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
	/**
	 * Consecutive calls the pinned model has timed out on. Reset by any success;
	 * at ROTATE_AFTER_TIMEOUTS the pin is released so the session re-picks.
	 */
	timeoutStreak: number;
	/**
	 * The candidate chain cached for the current (session model, classifier config)
	 * signature, so the O(catalog) ranking is not rebuilt on every gated tool call.
	 * Invalidated only when the session model or the `classifierModel` setting
	 * changes — catalog churn is deliberately ignored, matching the pin, which
	 * already commits the session to one classifier. The live `rejected` filter is
	 * still applied to the cached chain per call, so a model that dies mid-session
	 * is still stepped over without a rebuild.
	 */
	chainCache?: { signature: string; candidates: Candidate[]; notices: ClassifierNotice[] };
	/**
	 * `provider/id` -> the thinking level a model turned out to REQUIRE (its
	 * provider rejected the thinking-off request with "reasoning is mandatory").
	 * Learned once per model via a single retry, then sent on every later call so
	 * the failed round-trip is never paid again. Only needed when the model's
	 * catalog entry lacks `thinkingLevelMap.off: null` (that case is handled
	 * proactively, without an error).
	 */
	forcedReasoning: Map<string, ThinkingLevel>;
}

export function createClassifierState(): ClassifierState {
	return { rejected: new Set(), notified: new Set(), timeoutStreak: 0, forcedReasoning: new Map() };
}

export interface ClassifierDeps {
	registry: ModelRegistry;
	sessionModel: Model<Api> | undefined;
	config: AutoModeConfig;
	signal?: AbortSignal;
	state: ClassifierState;
	/** Tell the user something once — which model is in use, or that theirs is dead. */
	onNotice?: (message: string, level: "info" | "warning") => void;
	/** Report each classifier reply's usage, for the all-in footer cost. Observer
	 * only — it never affects the payload sent or the verdict parsed. */
	onUsage?: (usage: unknown) => void;
	/**
	 * Completed-run subagent review: evaluate the sequence with a single stage-2
	 * style full-eval call instead of the two-stage gate (there is no harm floor
	 * to short-circuit, and the whole point is the intent/ALLOW judgment).
	 */
	reviewOnly?: boolean;
}

/** How a single candidate's attempt failed, so the outer loop can react. */
type StepKind = "timeout" | "cancelled" | "unavailable" | "error" | "truncated";
class StepError extends Error {
	constructor(
		readonly kind: StepKind,
		message: string,
	) {
		super(message);
	}
}

/** Signature that must stay equal for the cached chain to be reused (see ClassifierState.chainCache). */
function selectionSignature(deps: ClassifierDeps): string {
	const session = deps.sessionModel ? `${deps.sessionModel.provider}/${deps.sessionModel.id}` : "(none)";
	return `${session}|${deps.config.classifierModel ?? ""}|${deps.config.classifierModelSetFor ?? ""}`;
}

/** The candidate chain (minus anything already unusable this session) and its notices. */
function remainingCandidates(deps: ClassifierDeps): { candidates: Candidate[]; notices: ClassifierNotice[] } {
	const signature = selectionSignature(deps);
	let cached = deps.state.chainCache;
	if (!cached || cached.signature !== signature) {
		const built = classifierCandidates({
			available: deps.registry.getAvailable(),
			sessionModel: deps.sessionModel,
			configured: deps.config.classifierModel,
			configuredSetForContainment: deps.config.classifierModelSetFor,
		});
		cached = { signature, candidates: built.candidates, notices: built.notices };
		// Don't poison the cache with an empty chain (e.g. a not-yet-populated
		// registry) — that would permanently block the gate; recompute next call.
		if (built.candidates.length > 0) deps.state.chainCache = cached;
	}
	const { candidates: all, notices } = cached;
	const usable = all.filter((entry) => !deps.state.rejected.has(`${entry.model.provider}/${entry.model.id}`));
	if (usable.length > 0) return { candidates: usable, notices };
	// If everything has been rejected, the session model is still worth one more
	// attempt: a gate that stops asking has stopped gating. It has to be the
	// session model specifically — the *last* chain entry is the cost-ranked pick,
	// which nothing price-chosen should lead, let alone be the sole retry.
	const session = all.filter((entry) => entry.source === "session");
	return { candidates: session.length > 0 ? session : all.slice(-1), notices };
}

function notifyOnce(deps: ClassifierDeps, key: string, message: string, level: "info" | "warning") {
	if (deps.state.notified.has(key)) return;
	deps.state.notified.add(key);
	deps.onNotice?.(message, level);
}

/**
 * Ask the classifier about one tool call (or, with `reviewOnly`, one finished
 * subagent run). See the module comment for the two-stage flow.
 */
export async function classify(request: ClassifyRequest, deps: ClassifierDeps): Promise<ClassifyVerdict> {
	const { candidates, notices } = remainingCandidates(deps);
	if (candidates.length === 0) {
		return { decision: "block", reason: "No model is available to run the auto-mode classifier.", tier: "unmatched" };
	}

	// Selection notices (a configured model unavailable or overridden as stale, a
	// cross-provider setting honored) — surfaced once each at their own level, keyed
	// by their text so an informational "honored" line is not shown as a warning.
	for (const notice of notices) notifyOnce(deps, notice.text, notice.text, notice.level);

	// buildPayload builds the ~110KB ruleset once and returns the grounding index
	// derived from it, so the ruleset is not rebuilt/re-parsed a second time here.
	const { system, userPrefix, index } = buildPayload(request);
	const stage1Text = stage1User(userPrefix);
	const debug = process.env.CC_AUTO_MODE_DEBUG;

	// A model already pinned this session is tried first, so the classifier does
	// not change under the session while the pin is healthy. The rest of the chain
	// stays behind it: a pinned model can be withdrawn mid-session, and the same
	// call must then step onward rather than fail every call forever.
	const pinned = deps.state.pinned;
	const attempts = pinned
		? [
				{ model: pinned, source: "session" as const },
				...candidates.filter((entry) => entry.model.provider !== pinned.provider || entry.model.id !== pinned.id),
			]
		: candidates;

	// Rejecting a model releases its pin: without that, a model withdrawn
	// mid-session would stay pinned, be the only candidate tried on every later
	// call, and turn the gate into a permanent block until restart.
	const reject = (key: string) => {
		deps.state.rejected.add(key);
		if (deps.state.pinned && `${deps.state.pinned.provider}/${deps.state.pinned.id}` === key) {
			deps.state.pinned = undefined;
		}
	};

	let lastError = "";
	let sawTimeout = false;
	let timedOutKey: string | undefined;
	// Walks `attempts` in order; a candidate that turns out to require thinking is
	// re-queued at the front for exactly one retry (see the reasoning-mandatory
	// branch below). The `!== undefined` guard narrows `candidate`, so no cast.
	const queue = [...attempts];
	for (let candidate = queue.shift(); candidate !== undefined; candidate = queue.shift()) {
		const model = candidate.model;
		const key = `${model.provider}/${model.id}`;

		const auth = await deps.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			reject(key);
			lastError = auth.error;
			continue;
		}
		const resolvedModel = withAuthBaseUrl(model, auth);

		// One provider call. `reasoning`/`temperature` are deliberately omitted: pi
		// turns thinking off entirely when `reasoning` is absent (what a classifier
		// wants), and `temperature` is deprecated/unsupported on several models and
		// fails closed. See docs/decisions/auto-mode.md. The one exception: a model
		// that CANNOT disable thinking (catalog-marked, or learned via the
		// reasoning-mandatory retry below) gets its lowest supported level — the
		// off-request would 400 and the gate would fail closed on every call.
		const reasoning = deps.state.forcedReasoning.get(key) ?? forcedReasoningLevel(model);
		const runCall = (userText: string, maxTokens: number, stage: number) => {
			if (debug === "2") {
				process.stderr.write(
					`\n[auto-mode payload] stage=${stage} model=${key} maxTokens=${maxTokens} systemLen=${system.length} userLen=${userText.length}\n` +
						`===SYSTEM===\n${system}\n===USER===\n${userText}\n===END===\n`,
				);
			}
			const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
			return completeSimple(
				resolvedModel,
				{ systemPrompt: system, messages: [{ role: "user", content: userText, timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
					maxTokens,
					cacheRetention: "long",
					...(reasoning ? { reasoning } : {}),
				},
			);
		};

		// Turn one reply into text, or throw a StepError the loop knows how to route.
		// `big` is the retry cap for a length-truncated reply; a still-truncated reply
		// at `big` is its own outcome (not a candidate to step past).
		const call = async (userText: string, base: number, big: number, stage: number): Promise<string> => {
			const inspect = (reply: AssistantMessage): string | "length" => {
				deps.onUsage?.(reply.usage);
				if (deps.signal?.aborted) throw new StepError("cancelled", "cancelled");
				if (reply.stopReason === "error" || reply.stopReason === "aborted") {
					const msg = reply.errorMessage ?? reply.stopReason ?? "provider error";
					if (isClassifierTimeout(msg)) throw new StepError("timeout", msg);
					throw new StepError(isModelUnavailableError(msg) ? "unavailable" : "error", msg);
				}
				if (reply.stopReason === "length") return "length";
				return replyText(reply);
			};

			let reply = await runCall(userText, base, stage);
			let seen: string | "length";
			try {
				seen = inspect(reply);
			} catch (error) {
				// One retry on a timeout, before giving up on this model — a stall under
				// load usually clears on a second try. A user cancel or a substantive
				// error is not retried.
				if (error instanceof StepError && error.kind === "timeout") {
					reply = await runCall(userText, base, stage);
					seen = inspect(reply);
				} else {
					throw error;
				}
			}
			if (seen !== "length") return seen;
			// A cut-off reply voids the verdict, so retry once with real headroom.
			reply = await runCall(userText, big, stage);
			const retried = inspect(reply);
			if (retried === "length") throw new StepError("truncated", "verdict truncated at maxTokens");
			return retried;
		};

		try {
			let verdict: ClassifyVerdict;
			let stageInfo: string;

			if (deps.reviewOnly) {
				// A finished run has no harm floor to short-circuit — go straight to the
				// full stage-2 evaluation, reframed to judge the whole sequence.
				const text = await call(reviewUser(userPrefix), 1024, 4096, 2);
				verdict = parseStage2(text, index, request.userMessages);
				stageInfo = `review sev=${parseSeverity(text) ?? "?"}`;
			} else {
				// STAGE 1 — harm only. maxTokens 64 like CC; if the reply overruns 64
				// without a readable severity, one retry with headroom recovers it.
				const s1 = await call(stage1Text, 64, 1024, 1);
				const sev1 = parseSeverity(s1);
				if (sev1 !== null && sev1 < SEVERITY_THRESHOLD) {
					verdict = { decision: "allow", reason: "", tier: "allow" };
					stageInfo = `s1=${sev1} (cleared, no stage 2)`;
				} else {
					// sev1 >= 50, or unparseable → fall to the fuller stage-2 evaluation.
					// stage2User is built here (not eagerly) so the common allow case
					// does not concatenate the transcript prefix a second time.
					const s2 = await call(stage2User(userPrefix), 1024, 4096, 2);
					verdict = parseStage2(s2, index, request.userMessages);
					stageInfo = `s1=${sev1 ?? "?"} s2=${parseSeverity(s2) ?? "?"}`;
				}
			}

			// A verdict came back, so any building timeout streak is over.
			deps.state.timeoutStreak = 0;
			// Pin on the first success, so the classifier cannot change under the
			// session and a working model is not re-litigated per call.
			if (!deps.state.pinned) {
				deps.state.pinned = model;
				notifyOnce(deps, `using:${key}`, `Auto mode is screening calls with ${describeCandidate(candidate)}.`, "info");
			}
			if (debug) {
				process.stderr.write(
					`[auto-mode] ${key} ${request.toolName} → ${verdict.decision}` +
						`${verdict.ruleId ? ` (${verdict.ruleId})` : ""} [${stageInfo}]\n` +
						(verdict.raw ? `  raw: ${verdict.raw.slice(0, 300)}\n` : ""),
				);
			}
			return verdict;
		} catch (error) {
			// A non-StepError is an unexpected throw; treat it as a substantive
			// "error" (surface it, don't step past it) — same as StepError("error").
			const kind: StepKind = error instanceof StepError ? error.kind : "error";
			lastError = error instanceof Error ? error.message : String(error);

			if (kind === "cancelled") {
				return { decision: "block", reason: "Auto-mode classification was cancelled.", tier: "unmatched" };
			}
			if (kind === "truncated") {
				if (debug) process.stderr.write(`[auto-mode] ${key} ${request.toolName} → verdict truncated at maxTokens\n`);
				return {
					decision: "block",
					reason:
						"The approval classifier's reply was cut off by its output limit before the verdict completed. If this keeps happening, pin a stronger classifier model with /auto-mode model.",
					tier: "unmatched",
				};
			}
			if (kind === "error") {
				// The provider refused the thinking-off request outright (metadata gap:
				// no `thinkingLevelMap.off: null` on this catalog entry). Learn the
				// model's floor once and retry the same candidate with it.
				if (!reasoning && isReasoningMandatoryError(lastError)) {
					const level = reasoningRetryLevel(model);
					deps.state.forcedReasoning.set(key, level);
					notifyOnce(
						deps,
						`forced-reasoning:${key}`,
						`${key} cannot run with thinking disabled; the classifier now runs it at ${level} thinking.`,
						"info",
					);
					queue.unshift(candidate);
					continue;
				}
				// A substantive, non-transient failure that is not "model unusable here":
				// surface it rather than papering over something about to clear.
				return { decision: "block", reason: `Auto-mode classifier could not be reached (${lastError}).`, tier: "unmatched" };
			}
			if (kind === "timeout") {
				// Transient — do NOT reject the model, it may be fine next call. Step to
				// the next candidate; a pinned model that keeps timing out is unpinned.
				sawTimeout = true;
				timedOutKey = key;
				if (deps.state.pinned && `${deps.state.pinned.provider}/${deps.state.pinned.id}` === key) {
					deps.state.timeoutStreak += 1;
					if (deps.state.timeoutStreak >= ROTATE_AFTER_TIMEOUTS) deps.state.pinned = undefined;
				}
				continue;
			}
			// unavailable: this model is not usable here — step over it and record it.
			reject(key);
			const isConfigured = candidate.source === "configured";
			notifyOnce(
				deps,
				`rejected:${key}`,
				isConfigured
					? `Auto mode cannot use ${key} from autoMode.classifierModel (${lastError}). Set a different model in ~/.onecode/settings.json.`
					: `Auto mode cannot use ${key} as its classifier (${lastError}); trying another model. Set autoMode.classifierModel in ~/.onecode/settings.json to choose one.`,
				"warning",
			);
		}
	}

	// Every candidate timed out (with a retry each) and none was reachable in time.
	// This is NOT a judgement that the call is unsafe — it was never screened — so
	// it is surfaced as its own tier. The gate turns a timeout into a user prompt
	// where it can, and only blocks outright when running non-interactively.
	if (sawTimeout) {
		const model = timedOutKey ? timedOutKey.split("/").pop() : undefined;
		return {
			decision: "block",
			tier: "timeout",
			reason:
				`Auto mode could not screen this ${request.toolName} call in time — the approval classifier${model ? ` (${model})` : ""} ` +
				"is temporarily unavailable (timed out), so the call was not judged either way.",
		};
	}

	// Every candidate was unusable — say which knob fixes it.
	return {
		decision: "block",
		reason: `No usable auto-mode classifier model (last error: ${lastError}). Set autoMode.classifierModel in ~/.onecode/settings.json.`,
		tier: "unmatched",
	};
}
