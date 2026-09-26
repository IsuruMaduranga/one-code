/**
 * Open a URL in the user's default browser (no dependency — platform command).
 *
 * Detached and unref'd so the auth flow never blocks on the browser process,
 * and errors are swallowed to a boolean: a headless box has no browser, in which
 * case the caller falls back to printing the URL for manual paste.
 *
 * The authorization URL is the server's choice (its metadata names the
 * endpoint, the SDK appends `&`-joined parameters), so two things hold for
 * every URL opened here. Only `https:`, or `http:` on a loopback host, is
 * opened: `open` and `xdg-open` hand any other scheme (`file:`, a custom
 * handler) to whatever the desktop registered for it. And on Windows the URL
 * never passes through `cmd.exe`: `cmd /c start "" <url>` cut the URL at its
 * first `&`, breaking every sign-in, and handed the rest to cmd's parser as
 * further commands. `rundll32 url.dll,FileProtocolHandler` takes the URL as
 * one argument, by its System32 path so no PATH entry can stand in for it.
 */

import { spawn } from "node:child_process";
import { system32Path } from "../../lib/paths.ts";

export type BrowserPlan = { command: string; args: string[] } | { refused: string };

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
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") return { command: system32Path("rundll32.exe", env), args: ["url.dll,FileProtocolHandler", url] };
	return { command: "xdg-open", args: [url] };
}

/**
 * Open `url`, or throw when it is refused: a sign-in the server pointed at a
 * non-web scheme is a hostile or broken server, and the error names why.
 * Returns false when the opener could not start (no browser on the box).
 */
export function openBrowser(url: string): boolean {
	const plan = browserOpenPlan(url);
	if ("refused" in plan) throw new Error(`refusing to open the authorization URL: ${plan.refused}`);
	try {
		const child = spawn(plan.command, plan.args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
