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
 *
 * A record belongs to a server, not a name: the file is keyed by the name
 * plus a sha256 of the server's URL and headers, and records the URL it was
 * issued for. Until 2026-09-27 it was keyed by name alone, so a project
 * `.mcp.json` server named like an authenticated user server received that
 * server's bearer token at its own URL. A record whose URL differs is never
 * offered, so a server whose URL or headers change signs in again.
 */

import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { readJsonFile, writeJsonAtomic } from "../../lib/atomic-write.ts";
import { oneCodeStateDir } from "../../lib/paths.ts";

/** The part of an http server's config its credentials are bound to. */
export interface OAuthServer {
	name: string;
	url: string;
	headers?: Record<string, string>;
}

export interface StoredAuth {
	/** The server URL the record was issued for; a record for another URL is never read. */
	serverUrl?: string;
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
function slug(server: OAuthServer): string {
	const headers = Object.entries(server.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const hash = createHash("sha256").update(JSON.stringify({ name: server.name, type: "http", url: server.url, headers })).digest("hex").slice(0, 16);
	const safe = server.name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
	return `${safe || "server"}-${hash}.json`;
}

export function authStoreDir(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
	return join(oneCodeStateDir(env, home), "mcp-auth");
}

function authFilePath(server: OAuthServer, home: string, env: NodeJS.ProcessEnv): string {
	return join(authStoreDir(home, env), slug(server));
}

export function readAuth(server: OAuthServer, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): StoredAuth {
	const stored = readJsonFile<StoredAuth>(authFilePath(server, home, env));
	return stored && stored.serverUrl === server.url ? stored : {};
}

export function writeAuth(
	server: OAuthServer,
	auth: StoredAuth,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	// Bearer tokens: owner-only file and directory (review M10). mkdir's mode
	// applies only on creation, so an existing dir is tightened explicitly.
	const dir = authStoreDir(home, env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Not fatal (a filesystem without modes); the file mode below still applies where it can.
	}
	writeJsonAtomic(authFilePath(server, home, env), { ...auth, serverUrl: server.url }, { mode: 0o600 });
}

/** Merge a partial update into the stored record. */
export function updateAuth(
	server: OAuthServer,
	patch: Partial<StoredAuth>,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	writeAuth(server, { ...readAuth(server, home, env), ...patch }, home, env);
}

/** True when a usable (non-empty) access token is stored for this server. */
export function hasStoredTokens(server: OAuthServer, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(readAuth(server, home, env).tokens?.access_token);
}
