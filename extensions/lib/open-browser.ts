/**
 * Hand a URL to the desktop's default handler (no dependency, a platform
 * command). Shared by the MCP sign-in flow (`mcp/oauth/browser.ts`, which also
 * screens the URL it is given) and the artifact viewer (`extensions/artifacts`,
 * which only ever opens `file:` URLs it built itself).
 *
 * The child is detached and unref'd so the caller never blocks on the browser
 * process, and a launch failure is swallowed to a boolean: a box with no
 * browser falls back to printing the target. On Windows the URL never passes
 * through `cmd.exe`: `cmd /c start "" <url>` cut a URL at its first `&` and
 * handed the rest to cmd's parser as further commands. `rundll32
 * url.dll,FileProtocolHandler` takes the URL as one argument, by its System32
 * path so no PATH entry can stand in for it.
 */

import { spawn } from "node:child_process";
import { system32Path } from "./paths.ts";

export interface OpenerPlan {
	command: string;
	args: string[];
}

/** The command and argv that open `url` on `platform`. Pure. */
export function openerPlan(url: string, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): OpenerPlan {
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") return { command: system32Path("rundll32.exe", env), args: ["url.dll,FileProtocolHandler", url] };
	return { command: "xdg-open", args: [url] };
}

/**
 * Why a browser opened from here would not reach the user, or undefined when
 * it would. Over SSH the opener runs on the remote machine's desktop, and a
 * Linux or BSD box with neither X nor Wayland has no desktop at all. Pure.
 */
export function noDisplayReason(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.SSH_CONNECTION || env.SSH_TTY) return "this session runs over SSH";
	if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "no graphical display is available";
	return undefined;
}

/** Start `plan` detached. False when the opener could not start. */
export function launchOpener(plan: OpenerPlan): boolean {
	try {
		const child = spawn(plan.command, plan.args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
