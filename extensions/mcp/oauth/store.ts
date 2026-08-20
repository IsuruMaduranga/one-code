/**
 * On-disk OAuth credential store for MCP servers.
 *
 * One JSON file per server under `~/.onecode/mcp-auth/<slug>.json`, holding the
 * dynamically-registered client info, the tokens (access + refresh), the PKCE
 * verifier mid-flow, and the cached discovery state. The MCP SDK's OAuth
 * provider (oauth/provider.ts) reads and writes through this; refresh happens
 * automatically once a refresh token is stored, so a one-time Authenticate keeps
 * the server connected across sessions.
 *
 * Kept in ~/.onecode (never ~/.claude) like all One Code state, and separate
 * from settings.json because tokens are secrets, not configuration.
 */

import { mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { readJsonFile, writeJsonAtomic } from "../../lib/atomic-write.ts";
import { oneCodeStateDir } from "../../lib/paths.ts";

export interface StoredAuth {
	clientInformation?: OAuthClientInformationFull;
	clientMetadata?: OAuthClientMetadata;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
}

/**
 * Filesystem-safe, collision-free file name for a server: a readable sanitized
 * stem plus a short hash of the raw name, so two names that sanitize alike
 * (e.g. "a/b" and "a_b") still get distinct files.
 */
function slug(serverName: string): string {
	let hash = 5381;
	for (let i = 0; i < serverName.length; i++) hash = ((hash << 5) + hash + serverName.charCodeAt(i)) >>> 0;
	const safe = serverName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
	return `${safe || "server"}-${hash.toString(16).padStart(8, "0")}.json`;
}

export function authStoreDir(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
	return join(oneCodeStateDir(env, home), "mcp-auth");
}

function authFilePath(serverName: string, home: string, env: NodeJS.ProcessEnv): string {
	return join(authStoreDir(home, env), slug(serverName));
}

export function readAuth(serverName: string, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): StoredAuth {
	return readJsonFile<StoredAuth>(authFilePath(serverName, home, env)) ?? {};
}

export function writeAuth(
	serverName: string,
	auth: StoredAuth,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	mkdirSync(authStoreDir(home, env), { recursive: true });
	writeJsonAtomic(authFilePath(serverName, home, env), auth);
}

/** Merge a partial update into the stored record. */
export function updateAuth(
	serverName: string,
	patch: Partial<StoredAuth>,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	writeAuth(serverName, { ...readAuth(serverName, home, env), ...patch }, home, env);
}

/** True when a usable (non-empty) access token is stored. */
export function hasStoredTokens(serverName: string, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(readAuth(serverName, home, env).tokens?.access_token);
}
