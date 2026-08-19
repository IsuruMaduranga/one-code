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
import { beginInteractiveAuth, type Connection, connect } from "../client.ts";
import { openBrowser } from "./browser.ts";
import { startCallbackServer } from "./callback.ts";
import { McpOAuthProvider } from "./provider.ts";

export interface AuthenticateOptions {
	server: HttpServer;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Progress/URL messages for the caller to surface (browser opened, or manual URL). */
	onPrompt?: (message: string) => void;
	timeoutMs?: number;
}

/** A provider for a silent (non-interactive) connect using already-stored tokens. */
export function silentProvider(serverName: string, home?: string, env?: NodeJS.ProcessEnv): McpOAuthProvider {
	return new McpOAuthProvider({ serverName, home, env });
}

export async function authenticate(options: AuthenticateOptions): Promise<Connection> {
	const { server, home, env, onPrompt, timeoutMs } = options;
	const callback = await startCallbackServer();
	try {
		const provider = new McpOAuthProvider({
			serverName: server.name,
			redirectUrl: callback.redirectUrl,
			openAuthorization: (url) => {
				const opened = openBrowser(url.toString());
				onPrompt?.(
					opened
						? `Opened your browser to authorize "${server.name}". If it didn't open, visit:\n${url}`
						: `Open this URL to authorize "${server.name}":\n${url}`,
				);
			},
			home,
			env,
		});

		const started = await beginInteractiveAuth(server, provider);
		if ("connection" in started) return started.connection; // valid tokens already present

		const code = await callback.waitForCode(timeoutMs);
		await started.transport.finishAuth(code);

		// Reconnect fresh: the provider now has stored tokens, so this is silent.
		return await connect(server, silentProvider(server.name, home, env));
	} finally {
		callback.close();
	}
}
