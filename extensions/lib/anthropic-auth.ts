/**
 * Whether the Anthropic login is OAuth (a Claude subscription) rather than an
 * API key. OAuth requests carry pi's identity betas and Claude Code's tool
 * names, so the auth kind is part of a request's identity (lib/ledger).
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RequestIdentity } from "./ledger/records.ts";

/** mtime cache: this runs on every provider request, the hottest path there is. */
let authCache: { mtimeMs: number; oauth: boolean } | undefined;

/** True when pi's auth.json holds an OAuth login for Anthropic. */
export function isAnthropicOAuth(): boolean {
	// getAgentDir() honours PI_CODING_AGENT_DIR, so an isolated one-code app
	// reads its own auth.json rather than ~/.pi's.
	const path = join(getAgentDir(), "auth.json");
	try {
		const mtimeMs = statSync(path).mtimeMs;
		const cached = authCache;
		if (cached && cached.mtimeMs === mtimeMs) return cached.oauth;
		const auth = JSON.parse(readFileSync(path, "utf8"));
		const entry = auth?.anthropic;
		const oauth = entry?.type === "oauth" || typeof entry?.refresh === "string";
		authCache = { mtimeMs, oauth };
		return oauth;
	} catch {
		authCache = undefined;
		return false;
	}
}

/** The auth kind a request to `provider` goes out with: "oauth" for an Anthropic subscription login, else "key". */
export function authKind(provider: string | undefined): "oauth" | "key" {
	return provider === "anthropic" && isAnthropicOAuth() ? "oauth" : "key";
}

/** Who a request to `model` goes to, as the ledger records it; a change opens an epoch. */
export function requestIdentity(model: { api: string; provider: string; id: string }): RequestIdentity {
	return { api: model.api, provider: model.provider, model: model.id, auth: authKind(model.provider) };
}
