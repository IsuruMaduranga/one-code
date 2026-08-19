/**
 * Open a URL in the user's default browser (no dependency — platform command).
 *
 * Detached and unref'd so the auth flow never blocks on the browser process,
 * and errors are swallowed to a boolean: a headless box has no browser, in which
 * case the caller falls back to printing the URL for manual paste.
 */

import { spawn } from "node:child_process";

export function openBrowser(url: string): boolean {
	const [command, args] =
		process.platform === "darwin"
			? (["open", [url]] as const)
			: process.platform === "win32"
				? (["cmd", ["/c", "start", "", url]] as const)
				: (["xdg-open", [url]] as const);
	try {
		const child = spawn(command, [...args], { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
