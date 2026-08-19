/**
 * An OAuthClientProvider for the MCP SDK, backed by the on-disk token store.
 *
 * The SDK's StreamableHTTPClientTransport drives the whole OAuth 2.1 flow
 * (discovery, dynamic client registration, PKCE, token exchange and refresh) and
 * calls into this provider for the three things only the host knows: where to
 * persist credentials (the store), where the redirect lands (the loopback URL),
 * and how to send the user to the authorization page (open a browser).
 *
 * One instance is scoped to one server for one flow; `redirectUrl` is fixed from
 * the loopback callback server. A non-interactive instance (startup reconnect
 * using stored tokens) is constructed without an opener and refuses to redirect.
 */

import type {
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { readAuth, type StoredAuth, writeAuth } from "./store.ts";

export interface McpOAuthProviderOptions {
	serverName: string;
	/** Loopback redirect_uri; required for an interactive flow, omitted for silent reconnect. */
	redirectUrl?: string;
	/** Sends the user to the authorization URL (opens a browser). Interactive flows only. */
	openAuthorization?: (url: URL) => void;
	home?: string;
	env?: NodeJS.ProcessEnv;
}

export class McpOAuthProvider implements OAuthClientProvider {
	private readonly serverName: string;
	private readonly _redirectUrl?: string;
	private readonly openAuthorization?: (url: URL) => void;
	private readonly home?: string;
	private readonly env?: NodeJS.ProcessEnv;

	// The SDK calls tokens() on every request it sends, so the parsed store is
	// cached in-instance and re-read only after this provider's own writes,
	// instead of a readFileSync + JSON.parse per getter.
	private cache?: StoredAuth;

	constructor(options: McpOAuthProviderOptions) {
		this.serverName = options.serverName;
		this._redirectUrl = options.redirectUrl;
		this.openAuthorization = options.openAuthorization;
		this.home = options.home;
		this.env = options.env;
	}

	private load(): StoredAuth {
		return (this.cache ??= readAuth(this.serverName, this.home, this.env));
	}

	/** Merge a patch into the cached store and persist it. */
	private save(patch: Partial<StoredAuth>): void {
		this.cache = { ...this.load(), ...patch };
		writeAuth(this.serverName, this.cache, this.home, this.env);
	}

	get redirectUrl(): string | URL | undefined {
		return this._redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		// A persisted metadata block keeps a re-registered client stable across
		// sessions; otherwise register as a public client using the loopback
		// redirect with the PKCE authorization-code grant.
		const stored = this.load().clientMetadata;
		if (stored) return stored;
		return {
			client_name: "One Code",
			redirect_uris: this._redirectUrl ? [this._redirectUrl] : [],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.load().clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.save({ clientInformation: clientInformation as OAuthClientInformationFull, clientMetadata: this.clientMetadata });
	}

	tokens(): OAuthTokens | undefined {
		return this.load().tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.save({ tokens });
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (!this.openAuthorization) {
			throw new Error(`MCP server "${this.serverName}" needs authentication; run /mcp and choose Authenticate.`);
		}
		this.openAuthorization(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.save({ codeVerifier });
	}

	codeVerifier(): string {
		const verifier = this.load().codeVerifier;
		if (!verifier) throw new Error("no PKCE code verifier saved for this authorization");
		return verifier;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.save({ discoveryState: state });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.load().discoveryState;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		this.save({
			clientInformation: scope === "all" || scope === "client" ? undefined : this.load().clientInformation,
			tokens: scope === "all" || scope === "tokens" ? undefined : this.load().tokens,
			codeVerifier: scope === "all" || scope === "verifier" ? undefined : this.load().codeVerifier,
			discoveryState: scope === "all" || scope === "discovery" ? undefined : this.load().discoveryState,
		});
	}
}
