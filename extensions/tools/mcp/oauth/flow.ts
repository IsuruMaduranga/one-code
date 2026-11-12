/**
 * Interactive OAuth orchestration for an http MCP server.
 *
 * Ties together the loopback callback catcher (callback.ts), the browser opener
 * (browser.ts), the SDK-backed provider (provider.ts), and the transport-level
 * auth entry points (client.ts): start a callback server, let the SDK register +
 * redirect the user to authorize, catch the returned code, finish the exchange,
 * then reconnect with the freshly stored tokens. The result is a live
 * Connection the caller registers exactly like any other.
 */

import type { HttpServer } from "../config.ts";
import { beginInteractiveAuth, type Connection, connect, finishInteractiveAuth } from "../client.ts";
import { openBrowser } from "./browser.ts";
import { startCallbackServer } from "./callback.ts";
import { McpOAuthProvider } from "./provider.ts";
import type { OAuthServer } from "./store.ts";

export interface AuthenticateOptions {
	server: HttpServer;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Progress/URL messages for the caller to surface (browser opened, or manual URL). */
	onPrompt?: (message: string) => void;
	timeoutMs?: number;
}

/** A provider for a silent (non-interactive) connect using already-stored tokens. */
export function silentProvider(server: OAuthServer, home?: string, env?: NodeJS.ProcessEnv): McpOAuthProvider {
	return new McpOAuthProvider({ server, home, env });
}

export async function authenticate(options: AuthenticateOptions): Promise<Connection> {
	const { server, home, env, onPrompt, timeoutMs } = options;
	const callback = await startCallbackServer();
	try {
		const provider = new McpOAuthProvider({
			server,
			redirectUrl: callback.redirectUrl,
			openAuthorization: (url) => {
				// A refused URL throws here, before any launch; the prompt waits
				// for the opener to report whether it started.
				void openBrowser(url.toString()).then((opened) =>
					onPrompt?.(
						opened
							? `Opened your browser to authorize "${server.name}". If it didn't open, visit:\n${url}`
							: `Open this URL to authorize "${server.name}":\n${url}`,
					),
				);
			},
			home,
			env,
		});

		const started = await beginInteractiveAuth(server, provider);
		if ("connection" in started) return started.connection; // valid tokens already present

		try {
			const { code, state } = await callback.waitForCode(timeoutMs);
			// Login-CSRF guard (RFC 8252 §8.9): the redirect must echo the state this
			// provider issued, or an attacker-planted code could bind their account.
			const expected = provider.expectedState();
			if (expected !== undefined && state !== expected) {
				throw new Error(`authorization response state mismatch for "${server.name}" — the redirect did not come from this authorization request`);
			}
			await finishInteractiveAuth(started.transport, code);
		} finally {
			await started.transport.close().catch(() => {});
		}

		// Reconnect fresh: the provider now has stored tokens, so this is silent.
		return await connect(server, silentProvider(server, home, env));
	} finally {
		callback.close();
	}
}
