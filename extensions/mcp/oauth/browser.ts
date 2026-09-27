/**
 * Open a sign-in URL in the user's default browser (`lib/open-browser.ts`),
 * falling back to printing the URL for manual paste when no browser starts.
 *
 * The authorization URL is the server's choice (its metadata names the
 * endpoint, the SDK appends `&`-joined parameters), so only `https:`, or
 * `http:` on a loopback host, is opened: `open` and `xdg-open` hand any other
 * scheme (`file:`, a custom handler) to whatever the desktop registered for it.
 */

import { launchOpener, type OpenerPlan, openerPlan } from "../../lib/open-browser.ts";

export type BrowserPlan = OpenerPlan | { refused: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why a URL must not be opened, or undefined when it may. */
export function refuseAuthorizationUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "it is not a valid URL";
	}
	if (parsed.protocol === "https:") return undefined;
	if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return undefined;
	return `its scheme is ${parsed.protocol} on ${parsed.hostname || "no host"}; a sign-in URL must be https (or http on a loopback host)`;
}

/** The command and argv that open `url` on `platform`, or why it is refused. Pure. */
export function browserOpenPlan(url: string, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): BrowserPlan {
	const refused = refuseAuthorizationUrl(url);
	if (refused) return { refused };
	return openerPlan(url, platform, env);
}

/**
 * Open `url`, or throw (synchronously) when it is refused: a sign-in the
 * server pointed at a non-web scheme is a hostile or broken server, and the
 * error names why. Resolves false when the opener could not start (no browser
 * on the box).
 */
export function openBrowser(url: string): Promise<boolean> {
	const plan = browserOpenPlan(url);
	if ("refused" in plan) throw new Error(`refusing to open the authorization URL: ${plan.refused}`);
	return launchOpener(plan);
}
