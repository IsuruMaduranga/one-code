/**
 * The login a request goes out under, and the rest of a request's identity
 * (lib/ledger): every input that makes pi-ai build a differently shaped
 * request. An Anthropic OAuth login (a Claude subscription) carries pi's
 * identity betas and Claude Code's tool names; Sign in with ChatGPT drops
 * OpenAI's per-message `configuration_update` items and the cache fields
 * (pi-ai openai-responses.js isChatGPTSignIn); thinking turned off drops
 * pi-ai's per-message effort markers on a model that takes them. A change
 * of any of them opens an epoch, so recorded history is never replayed in a
 * shape pi would not build.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RequestIdentity } from "./ledger/records.ts";

/** mtime cache: this runs on every provider request, the hottest path there is. */
let authCache: { mtimeMs: number; oauth: ReadonlySet<string> } | undefined;

/** The providers pi's auth.json holds an OAuth login for. */
function oauthProviders(): ReadonlySet<string> {
	// getAgentDir() honours PI_CODING_AGENT_DIR, so an isolated one-code app
	// reads its own auth.json rather than ~/.pi's.
	const path = join(getAgentDir(), "auth.json");
	try {
		const mtimeMs = statSync(path).mtimeMs;
		const cached = authCache;
		if (cached && cached.mtimeMs === mtimeMs) return cached.oauth;
		const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, { type?: unknown; refresh?: unknown } | undefined>;
		const oauth = new Set(Object.entries(auth ?? {}).flatMap(([provider, entry]) => (entry?.type === "oauth" || typeof entry?.refresh === "string" ? [provider] : [])));
		authCache = { mtimeMs, oauth };
		return oauth;
	} catch {
		authCache = undefined;
		return new Set();
	}
}

/** True when pi's auth.json holds an OAuth login for Anthropic. */
export function isAnthropicOAuth(): boolean {
	return oauthProviders().has("anthropic");
}

/** OpenAI's own endpoint, where pi-ai treats a login that is not an `sk-` key as Sign in with ChatGPT. */
const OPENAI_API = "https://api.openai.com/v1";

/**
 * The auth kind a request to `provider` goes out with: "oauth" for an
 * Anthropic subscription login, "chatgpt" for Sign in with ChatGPT on
 * OpenAI's own endpoint, else "key".
 */
export function authKind(provider: string | undefined, baseUrl?: string): "oauth" | "chatgpt" | "key" {
	if (provider === "anthropic") return isAnthropicOAuth() ? "oauth" : "key";
	if (provider === "openai" && baseUrl === OPENAI_API && oauthProviders().has("openai")) return "chatgpt";
	return "key";
}

interface IdentityModel {
	api?: string;
	provider?: string;
	id?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, unknown>;
	compat?: unknown;
}

/**
 * Whether pi-ai puts its per-message effort markers in the request (an
 * effort directive before each earlier reply, a Responses
 * `configuration_update`): only on a model that takes them, and not while
 * thinking is off there (pi-ai anthropic-messages.js effortMessages).
 * Undefined on a model without them, or when the level is unknown.
 */
function effortMarkers(model: IdentityModel, thinkingLevel: string | undefined): boolean | undefined {
	if ((model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort !== true || thinkingLevel === undefined) return undefined;
	return !(thinkingLevel === "off" && model.reasoning === true && model.thinkingLevelMap?.off !== null);
}

/**
 * Who a request to `model` goes to and how pi-ai shapes it, as the ledger
 * records it; a change opens an epoch. `thinkingLevel` is the session's
 * (`pi.getThinkingLevel()`). Undefined without a full model.
 */
export function requestIdentity(model: IdentityModel | undefined, thinkingLevel?: string): RequestIdentity | undefined {
	if (!model?.api || !model.provider || !model.id) return undefined;
	const markers = effortMarkers(model, thinkingLevel);
	return { api: model.api, provider: model.provider, model: model.id, auth: authKind(model.provider, model.baseUrl), ...(markers !== undefined ? { effortMarkers: markers } : {}) };
}

/**
 * The identity of a request this session sends to `model` now, under the
 * session's thinking level (undefined where the API lacks it: a test double).
 */
export function sessionIdentity(pi: { getThinkingLevel?: () => string }, model: IdentityModel | undefined): RequestIdentity | undefined {
	return requestIdentity(model, typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined);
}
