/**
 * sandbox extension: the shell sandbox's session wiring (the mechanism is
 * lib/shell-run/sandbox.ts; the tools wrap their commands through it).
 *
 * When the user's settings turn the sandbox on (`sandbox.enabled`), it starts
 * with the session and stops with it, and the model reads how it is
 * configured in a section in front of the environment block, as in Claude
 * Code. The section is told once per epoch; a change since then (a resume
 * under other settings) goes on the request's tail. A host the settings do
 * not list is decided by the permission mode (hosts.ts): the user is asked
 * in the manual modes, and auto mode sends the model to the command's own
 * host list. `/sandbox` shows the state.
 *
 * Child sessions do not load this file: they share the process's sandbox.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { privateSessionTempDir } from "../../lib/core/scratchpad.ts";
import { sessionView } from "../../lib/agents/child-extensions.ts";
import { bindGatePrompt } from "../../lib/consent/gate-prompt.ts";
import { desktopNotificationText } from "../../lib/notify/desktop.ts";
import { brand } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import { projectConfigDir } from "../../lib/profile/sources.ts";
import { gateControlFiles } from "../../lib/profile/settings-files.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest, toldBlockFact, untoldBlockFact } from "../../lib/request/reminders.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../lib/rules/modes.ts";
import { listWorkspaceDirectories } from "../../lib/rules/settings.ts";
import { activeSandbox, sandboxConfigured, sandboxPlatform, sandboxSettings, sandboxUnavailable, startSandbox, stopSandbox } from "../../lib/shell-run/sandbox.ts";
import { registerLocalCommand } from "../../lib/ui/local-command.ts";
import { createHostGate, type HostAnswer } from "./hosts.ts";
import { hostPromptOptions, hostPromptTitle, sandboxSectionText, sandboxStatusLines } from "./section.ts";

/**
 * What a project's config folder holds that runs or steers the agent: never
 * writable from inside the sandbox, whatever allows the project directory.
 * With auto-allow on, a sandboxed command runs without a prompt in the
 * manual modes, so the sandbox is what keeps it off them. The settings files are in
 * `gateControlFiles`; the runtime itself denies the shell and git startup
 * files, `.git/hooks`, `.git/config`, `.vscode` and `.idea`.
 */
const PROTECTED_CONFIG_CHILDREN = ["skills", "hooks", "commands", "agents", "rules", "workflows"];
const protectedConfig = (dir: string): string[] => PROTECTED_CONFIG_CHILDREN.map((child) => join(projectConfigDir(dir), child));

/** The told fact of the sandbox section. */
const SANDBOX_FACT = "sandbox:section";

function sandboxExtension(pi: ExtensionAPI) {
	const text = sessionView(pi).text("shell").sandbox;
	let mode = "default";
	let cwd = process.cwd();
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		mode = (data as PermissionStatus).mode;
	});

	// The session's latest context: a host prompt opens on it, mid-command.
	let liveCtx: ExtensionContext | undefined;
	const askUser = async (host: string, port: number | undefined): Promise<HostAnswer> => {
		const ctx = liveCtx;
		if (!ctx) return undefined;
		const options = hostPromptOptions(host);
		const choice = await bindGatePrompt(pi.events, ctx)(desktopNotificationText.permission(brand.name, "Bash"), ctx.signal, () => ctx.ui.select(hostPromptTitle(host, port), [options.once, options.session, options.no], { signal: ctx.signal }));
		return choice === options.once ? "once" : choice === options.session ? "session" : choice === options.no ? "no" : undefined;
	};
	const hosts = createHostGate({ mode: () => mode, notListed: text.hostNotListed, prompt: askUser });
	pi.on("agent_end", () => hosts.endRun());

	registerLocalCommand(pi, "sandbox", {
		description: "Show the command sandbox's state and rules",
		handler: async (_args, ctx) => {
			ctx.ui.notify(sandboxStatusLines({ settings: sandboxSettings(), platform: sandboxPlatform(), active: activeSandbox(), unavailable: sandboxUnavailable(), cwd: ctx.cwd, sessionHosts: hosts.sessionHosts() }).join("\n"), "info");
		},
	});

	/** The section for a command run in `dir`, or null when no sandbox is configured. */
	const section = (dir: string): string | null => (sandboxConfigured() ? sandboxSectionText(text, { settings: sandboxSettings(), platform: sandboxPlatform()!, active: activeSandbox(), unavailable: sandboxUnavailable(), cwd: dir }) : null);

	// Told on the tail when it is not what the epoch's message 1 says: a
	// session resumed under other settings, or a sandbox that could not start.
	pi.events.on(RENDER_CHANNEL, (data) => {
		const request = data as RenderRequest;
		if (request.epoch) return;
		const live = section(cwd);
		const fact = untoldBlockFact(request, SANDBOX_FACT, live);
		if (fact) request.blocks.push({ text: live ?? text.turnedOff, facts: [fact] });
	});

	if (!sandboxConfigured()) return;

	let starting: Promise<unknown> = Promise.resolve();
	let warned = false;
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cwd = ctx.cwd;
		liveCtx = ctx;
		const home = homedir();
		const tempDir = privateSessionTempDir(ctx.cwd, ctx.sessionManager.getSessionId());
		const workspace = listWorkspaceDirectories(ctx.cwd, home).map((dir) => dir.path);
		// Not awaited: a session must not wait on the proxy. The first command does (lib/shell-run/sandbox.ts).
		starting = startSandbox({
			cwd: ctx.cwd,
			...(tempDir ? { tempDir } : {}),
			scopeFor: (dir) => ({ cwd: dir, writableDirs: [...(tempDir ? [tempDir] : []), ...workspace], protectedFiles: [...gateControlFiles(dir, home), ...[dir, ...workspace].flatMap(protectedConfig)] }),
			// A host the settings do not list (hosts.ts).
			ask: hosts.ask,
		}).then((failure) => {
			if (!failure || warned) return;
			warned = true;
			const message = `The command sandbox could not start (${failure}). ${sandboxSettings().failIfUnavailable ? "Shell commands are refused until it can." : "Shell commands run without it."}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		});
	});
	pi.on("session_shutdown", async () => {
		await starting;
		await stopSandbox();
	});

	pi.on("turn_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		liveCtx = ctx;
		// The section names whether the sandbox started, so it waits for the answer.
		await starting;
		const live = section(ctx.cwd);
		if (live === null) return;
		pi.events.emit(REMINDER_CHANNEL, { text: live, key: "sandbox", placement: "first-prepend", order: CONTEXT_ORDER.sandbox, facts: [toldBlockFact(SANDBOX_FACT, live)] });
	});
}

export default feature("sandbox", sandboxExtension);
