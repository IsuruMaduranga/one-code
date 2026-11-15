/**
 * Hand a URL to the desktop's default handler (no dependency, a platform
 * command). Shared by the MCP sign-in flow (`tools/mcp/oauth/browser.ts`, which also
 * screens the URL it is given), the artifact viewer (`extensions/tools/artifacts`,
 * which only ever opens `file:` URLs it built itself) and a product's own
 * extensions (`openInBrowser`, on `extensions/sdk/extension.ts`).
 *
 * The child is detached and unref'd once it starts, so the caller never
 * blocks on the browser process. A launch failure resolves to the command and
 * the system's message: a box with no browser falls back to printing the
 * target, and says what failed. On Windows the URL never passes
 * through `cmd.exe`: `cmd /c start "" <url>` cut a URL at its first `&` and
 * handed the rest to cmd's parser as further commands. `rundll32
 * url.dll,FileProtocolHandler` takes the URL as one argument, by its System32
 * path so no PATH entry can stand in for it.
 */

import { spawn } from "node:child_process";
import { system32Path } from "../profile/paths.ts";

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
 * it would: `ssh` (the opener runs on the remote machine's desktop) or
 * `noDisplay` (a Linux or BSD box with neither X nor Wayland has no desktop
 * at all). The caller words it. Pure.
 */
export function noDisplayReason(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): "ssh" | "noDisplay" | undefined {
	if (env.SSH_CONNECTION || env.SSH_TTY) return "ssh";
	if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "noDisplay";
	return undefined;
}

/** An opener that did not start: the command tried and the system's message (`spawn xdg-open ENOENT`). */
export interface OpenerFailure {
	command: string;
	osMessage: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Start `plan` detached. Resolves undefined once the opener has started, or
 * why it could not: a missing `xdg-open` is reported by an `error` event after
 * `spawn` returns, so success waits for the `spawn` event. The child stays
 * ref'd until then, so a one-shot run cannot exit mid-launch.
 */
export function launchOpener(plan: OpenerPlan): Promise<OpenerFailure | undefined> {
	return new Promise((resolve) => {
		const failed = (error: unknown) => resolve({ command: plan.command, osMessage: messageOf(error) });
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(plan.command, plan.args, { stdio: "ignore", detached: true });
		} catch (error) {
			failed(error);
			return;
		}
		child.once("error", failed);
		child.once("spawn", () => {
			child.unref();
			resolve(undefined);
		});
	});
}

/**
 * Why no browser was opened: no desktop reachable from here (`ssh`,
 * `noDisplay`; see `noDisplayReason`), or the opener did not start, with the
 * command and the system's message so the caller can name what to install.
 */
export type NoBrowser = { reason: "ssh" | "noDisplay" } | ({ reason: "launchFailed" } & OpenerFailure);

/**
 * Open `url` with the desktop's default handler: why no browser opened, or
 * undefined when the opener started. The URL is handed over as given, so a
 * caller opening a URL it did not build screens its scheme first (as the
 * sign-in flow does).
 */
export async function openInBrowser(url: string): Promise<NoBrowser | undefined> {
	const reason = noDisplayReason();
	if (reason) return { reason };
	const failure = await launchOpener(openerPlan(url));
	return failure ? { reason: "launchFailed", ...failure } : undefined;
}
