/**
 * Loopback HTTP server that catches the OAuth authorization-code redirect.
 *
 * The MCP OAuth flow redirects the browser to `http://127.0.0.1:<port>/callback?code=…`
 * after the user authorizes. This binds an ephemeral loopback port, hands its URL
 * back as the redirect_uri, and resolves `waitForCode()` with the code (or rejects
 * on an `error=` param / timeout). RFC 8252 §7.3 lets loopback redirects use any
 * port, so a fresh port per flow is fine even against a previously-registered client.
 */

import { createServer, type Server } from "node:http";

export interface CallbackServer {
	/** The exact redirect_uri to register and hand to the authorization request. */
	redirectUrl: string;
	/** Resolves with the authorization code once the browser is redirected back. */
	waitForCode: (timeoutMs?: number) => Promise<string>;
	close: () => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** HTML the browser lands on after redirect — self-closes where the browser allows it. */
function landingPage(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>One Code</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${message}</h2><p>You can close this tab and return to the terminal.</p><script>setTimeout(()=>window.close(),1500)</script></body>`;
}

export async function startCallbackServer(): Promise<CallbackServer> {
	// The result may arrive before waitForCode() installs its handlers (an IdP
	// with a live session can redirect instantly), so buffer it: settle() records
	// the outcome, and waitForCode() replays a buffered one immediately.
	let resolveCode: ((code: string) => void) | undefined;
	let rejectCode: ((error: Error) => void) | undefined;
	let outcome: { code: string } | { error: Error } | undefined;
	const settle = (result: { code: string } | { error: Error }) => {
		if (outcome) return;
		outcome = result;
		if ("code" in result) resolveCode?.(result.code);
		else rejectCode?.(result.error);
	};

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/callback") {
			res.writeHead(404).end();
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		if (error) {
			res.writeHead(400, { "content-type": "text/html" }).end(landingPage("Authorization failed"));
			settle({ error: new Error(`authorization denied: ${url.searchParams.get("error_description") ?? error}`) });
			return;
		}
		if (!code) {
			res.writeHead(400, { "content-type": "text/html" }).end(landingPage("Missing authorization code"));
			return;
		}
		res.writeHead(200, { "content-type": "text/html" }).end(landingPage("Authorization complete"));
		settle({ code });
	});

	// Bind to loopback on an ephemeral port; the OS picks a free one.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("could not determine loopback callback port");
	}
	const redirectUrl = `http://127.0.0.1:${address.port}/callback`;

	const waitForCode = (timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> =>
		new Promise<string>((resolve, reject) => {
			// Replay a result that already arrived before this call.
			if (outcome) {
				if ("code" in outcome) resolve(outcome.code);
				else reject(outcome.error);
				return;
			}
			resolveCode = resolve;
			rejectCode = reject;
			const timer = setTimeout(
				() => settle({ error: new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for authorization`) }),
				timeoutMs,
			);
			timer.unref?.();
		});

	return {
		redirectUrl,
		waitForCode,
		close: () => {
			try {
				server.close();
			} catch {
				// already closing
			}
		},
	};
}
