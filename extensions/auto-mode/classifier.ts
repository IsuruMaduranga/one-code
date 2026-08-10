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
	// `\babort` (no trailing boundary) so "abort", "aborted", and "aborting" all
	// match — the observed message is "Request aborted", which a trailing \b
	// would miss. The others are whole words.
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
	 * at ROTATE_AFTER_TIMEOUTS the pin is released so the session re-picks rather
	 * than staying bound to a model that has fallen behind demand.
	 */
	timeoutStreak: number;
}

export function createClassifierState(): ClassifierState {
	return { rejected: new Set(), notified: new Set(), timeoutStreak: 0 };
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
	if (usable.length > 0) return usable;
	// If everything has been rejected, the session model is still worth one more
	// attempt: a gate that stops asking has stopped gating. It has to be the
	// session model specifically — the *last* chain entry is the cost-ranked
	// pick, which nothing price-chosen should lead, let alone be the sole retry.
	const session = all.filter((entry) => entry.source === "session");
	return session.length > 0 ? session : all.slice(-1);
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

	// A model already pinned this session is tried first, so the classifier does
	// not change under the session while the pin is healthy. The rest of the
	// chain stays behind it: a pinned model can be withdrawn mid-session, and
	// the same call must then step onward rather than fail every call forever.
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
	for (const candidate of attempts) {
		const model = candidate.model;
		const key = `${model.provider}/${model.id}`;

		const auth = await deps.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			reject(key);
			lastError = auth.error;
			continue;
		}

		// Some pi builds resolve a per-provider baseUrl alongside the key; it is not
		// in every published version of the auth type, so it is read defensively.
		const baseUrl = (auth as { baseUrl?: string }).baseUrl;

		const attempt = (maxTokens: number) => {
			const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
			return completeSimple(
				baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model,
				{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
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
					maxTokens,
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
		};

		// A cut-off reply (stopReason "length") voids the verdict, so retry once with
		// real headroom. Used for both the initial call and the post-timeout retry.
		const attemptWithLengthRetry = async () => {
			let reply = await attempt(1024);
			if (reply.stopReason === "length") reply = await attempt(4096);
			return reply;
		};

		let failure: string | undefined;
		try {
			// A verdict is one JSON object, but the cap needs headroom over "one
			// JSON object": models that reasoning cannot be disabled on (deepseek
			// via opencode, observed live) burn output budget on deliberation —
			// most on exactly the risky calls that deserve it — and a truncated
			// reply voids the verdict. So a cut-off reply gets one retry with real
			// headroom and a fresh timeout; the cap bounds runaway output, not
			// typical cost, since replies still stop at the closing brace.
			let reply = await attemptWithLengthRetry();

			// One retry on a timeout, before giving up on this model. A stall under
			// load usually clears on a second try; a model that is simply too slow
			// times out again, and the loop then steps to the next candidate (or, if
			// none remains, the call falls through to a user prompt). A *user* cancel
			// also aborts — that is not a timeout and must not be retried.
			if (
				(reply.stopReason === "aborted" || reply.stopReason === "error") &&
				!deps.signal?.aborted &&
				isClassifierTimeout(reply.errorMessage ?? reply.stopReason ?? "")
			) {
				reply = await attemptWithLengthRetry();
			}

			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				failure = reply.errorMessage ?? reply.stopReason;
			} else if (reply.stopReason === "length") {
				// Still cut off at 4096 — same treatment as an unparseable reply (a
				// verdict that cannot be read approved nothing), but named, because
				// "unreadable response" sent a live debugging session hunting for
				// JSON bugs when the real cause was the output budget.
				if (process.env.CC_AUTO_MODE_DEBUG) {
					const u = reply.usage as { input?: number; output?: number; reasoning?: number } | undefined;
					process.stderr.write(
						`[auto-mode] ${key} ${request.toolName} → verdict truncated at maxTokens ` +
							`(in=${u?.input ?? "?"} out=${u?.output ?? "?"} reasoning=${u?.reasoning ?? 0})\n`,
					);
				}
				return {
					decision: "block",
					reason:
						"The approval classifier's reply was cut off by its output limit before the verdict completed — its analysis ran too long. If this keeps happening, pin a stronger classifier model with /auto-mode model.",
					tier: "unmatched",
				};
			} else {
				const text = reply.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("");
				const verdict = parseVerdict(text, index, request.userMessages);

				// A verdict came back, so the timeout streak that might have been
				// building is over.
				deps.state.timeoutStreak = 0;

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
						| {
								input?: number;
								output?: number;
								reasoning?: number;
								cacheRead?: number;
								cacheWrite?: number;
								cost?: unknown;
						  }
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
							`  usage: in=${u?.input ?? "?"} out=${u?.output ?? "?"} reasoning=${u?.reasoning ?? 0} cacheRead=${u?.cacheRead ?? 0} cacheWrite=${u?.cacheWrite ?? 0} ${spend}\n` +
							`  raw: ${text.replace(/\s+/g, " ").slice(0, 400)}\n`,
					);
				}
				return verdict;
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}

		lastError = failure ?? "unknown error";

		// A user cancel aborts the same way a timeout does. It is not a failure to
		// route around — the user asked to stop, so stop.
		if (deps.signal?.aborted) {
			return { decision: "block", reason: "Auto-mode classification was cancelled.", tier: "unmatched" };
		}

		// A timeout (after the one retry above) is transient, so the model is NOT
		// rejected — it may be fine on the next call. Instead we step to the next
		// candidate, which is a different model of the *same or cheaper* price in
		// the same provider (the chain is privacy- and budget-contained upstream).
		// A pinned model that keeps timing out is unpinned so the session re-picks.
		if (isClassifierTimeout(lastError)) {
			sawTimeout = true;
			if (deps.state.pinned && `${deps.state.pinned.provider}/${deps.state.pinned.id}` === key) {
				deps.state.timeoutStreak += 1;
				if (deps.state.timeoutStreak >= ROTATE_AFTER_TIMEOUTS) deps.state.pinned = undefined;
			}
			continue;
		}

		// A model that is simply not usable here is worth stepping over. Any other
		// transient failure is not: switching models would paper over something
		// about to clear, so that surfaces as a block and the same model is tried
		// again next call.
		if (!isModelUnavailableError(lastError)) {
			return {
				decision: "block",
				reason: `Auto-mode classifier could not be reached (${lastError}).`,
				tier: "unmatched",
			};
		}

		reject(key);
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

	// Every candidate timed out (with a retry each) and none was reachable in
	// time. This is NOT a judgement that the call is unsafe — it was never
	// screened — so it is surfaced as its own tier. The gate turns a `timeout`
	// into a user prompt where it can (there is someone to ask), and only blocks
	// outright when running non-interactively.
	if (sawTimeout) {
		return {
			decision: "block",
			tier: "timeout",
			reason:
				"Auto mode could not screen this call in time — the approval classifier timed out, so the call was not judged either way. " +
				"Approve it if you recognise it as safe, or pin a faster classifier with /auto-mode model.",
		};
	}

	// Every candidate was unusable — say which knob fixes it rather than leaving
	// the user with a gate that blocks everything for no stated reason.
	return {
		decision: "block",
		reason: `No usable auto-mode classifier model (last error: ${lastError}). Set autoMode.classifierModel in ~/.claude/settings.json.`,
		tier: "unmatched",
	};
}
