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
 * host list. `/sandbox` opens the panel (panel.ts): the mode, the overrides
 * and the rules in force.
 *
 * A child session loads child.ts: it shares the process's sandbox and only
 * tells its own model the section (`tellSandboxSection`).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { privateSessionTempDir } from "../../lib/core/scratchpad.ts";
import { sessionView } from "../../lib/agents/child-extensions.ts";
import { requestGatePrompt } from "../../lib/consent/gate-prompt.ts";
import { desktopNotificationText } from "../../lib/notify/desktop.ts";
import { brand } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import { projectConfigDir } from "../../lib/profile/sources.ts";
import { gateControlFiles } from "../../lib/profile/settings-files.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest, toldBlockFact, untoldBlockFact } from "../../lib/request/reminders.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../lib/rules/modes.ts";
import { activeSandbox, reloadSandboxSettings, SANDBOX_UNSUPPORTED, sandboxConfigured, sandboxPlatform, sandboxSettings, sandboxSettled, sandboxUnavailable, sandboxUnsupported, startSandbox, stopSandbox, useSandboxSettingsFor } from "../../lib/shell-run/sandbox.ts";
import { canShowCustomUi } from "../../lib/notify/headless-output.ts";
import { productSettingsPath, readSettingsForWrite, writeSettings } from "../../lib/profile/product-settings.ts";
import { WORKSPACE_CHANNEL, type WorkspaceAnnouncement } from "../../lib/rules/workspace-channel.ts";
import { panelUi } from "../../lib/ui/panel-focus.ts";
import { boundedDockHeight, safeThemeBold, safeThemePaint, truncateLine } from "../../lib/ui/tui-render.ts";
import { applySandboxPanelKey, applySandboxPick, decodeSandboxPanelKey, openSandboxPanel, renderSandboxPanel, sandboxConfigRows, sandboxModeOf, sandboxOverrideOf, sandboxPickOutcome } from "./panel.ts";
import { registerLocalCommand } from "../../lib/ui/local-command.ts";
import { checkoutProtectedFiles, linkedWorktreeGitDirs, type SandboxScope, shadowedAllowRead } from "../../lib/shell-run/sandbox-settings.ts";
import { followWorkCwd } from "../../lib/agents/worktree-channel.ts";
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

/** What a session is told when its settings ask for a sandbox the platform does not have. */
function unsupportedSandboxMessage(required: boolean): string {
	return `The command sandbox is turned on, but ${SANDBOX_UNSUPPORTED}. ${required ? "Shell commands are refused (sandbox.failIfUnavailable)." : "Shell commands run without it."}`;
}

/** The told fact of the sandbox section. */
const SANDBOX_FACT = "sandbox:section";

/** Rows the panel may take; the terminal's own height caps it. */
const SANDBOX_PANEL_MAX_HEIGHT = 30;

/**
 * Tell this session's model the sandbox section: in message 1 when an epoch
 * opens, and on the request's tail when it is no longer what message 1 says
 * (a session resumed under other settings, a sandbox that could not start, a
 * workspace directory added since). The main session and every child session
 * do this for themselves; the sandbox they describe is the process's one.
 */
export function tellSandboxSection(pi: ExtensionAPI): void {
	const text = sessionView(pi).text("shell").sandbox;
	// Where the session's commands run: the worktree it entered, else its own directory.
	const workCwd = followWorkCwd(pi.events);
	let cwd = process.cwd();
	/** The section for a command run in `dir`, or null when no sandbox is configured. */
	const section = (dir: string): string | null => (sandboxConfigured() ? sandboxSectionText(text, { settings: sandboxSettings(), platform: sandboxPlatform()!, active: activeSandbox(), unavailable: sandboxUnavailable(), cwd: dir }) : null);

	pi.events.on(RENDER_CHANNEL, (data) => {
		const request = data as RenderRequest;
		if (request.epoch) return;
		const live = section(cwd);
		const fact = untoldBlockFact(request, SANDBOX_FACT, live);
		if (fact) request.blocks.push({ text: live ?? text.turnedOff, facts: [fact] });
	});
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cwd = workCwd(ctx.cwd);
	});
	pi.on("turn_start", async (_event, ctx) => {
		cwd = workCwd(ctx.cwd);
		if (!sandboxConfigured()) return;
		// The section names whether the sandbox started, so it waits for the answer.
		await sandboxSettled();
		const live = section(cwd);
		if (live === null) return;
		pi.events.emit(REMINDER_CHANNEL, { text: live, key: "sandbox", placement: "first-prepend", order: CONTEXT_ORDER.sandbox, facts: [toldBlockFact(SANDBOX_FACT, live)] });
	});
}

function sandboxExtension(pi: ExtensionAPI) {
	const text = sessionView(pi).text("shell").sandbox;
	let mode = "default";
	// The workspace directories in force, as the permission gate announces them: a directory added mid-session
	// is writable from the next command, and one a repository names counts only once the user trusts it.
	let workspace: string[] = [];
	pi.events.on(WORKSPACE_CHANNEL, (data) => {
		const dirs = (data as WorkspaceAnnouncement | undefined)?.dirs;
		workspace = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : [];
		scopes = new Map();
	});
	// What a command run in a directory may and may never write, kept per directory: it is asked for on every
	// command, every request and every turn, and finding the gate's files walks the directory's parents.
	let scopes = new Map<string, SandboxScope>();
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		mode = (data as PermissionStatus).mode;
	});

	// The session's latest context: a host prompt opens on it, mid-command.
	let liveCtx: ExtensionContext | undefined;
	const askUser = async (host: string, port: number | undefined): Promise<HostAnswer> => {
		const ctx = liveCtx;
		if (!ctx) return undefined;
		const options = hostPromptOptions(host);
		// In the permission gate's own prompt queue: one prompt at a time, and none on top of an open panel.
		const choice = await requestGatePrompt(pi.events, ctx, desktopNotificationText.permission(brand.name, "Bash"), ctx.signal, () => ctx.ui.select(hostPromptTitle(host, port), [options.once, options.session, options.no], { signal: ctx.signal }));
		return choice === options.once ? "once" : choice === options.session ? "session" : choice === options.no ? "no" : undefined;
	};
	const hosts = createHostGate({ mode: () => mode, notListed: text.hostNotListed, prompt: askUser });
	pi.on("agent_end", () => hosts.endRun());

	const statusLines = (ctx: ExtensionContext) => sandboxStatusLines({ settings: sandboxSettings(), platform: sandboxPlatform(), active: activeSandbox(), unavailable: sandboxUnavailable(), cwd: ctx.cwd, sessionHosts: hosts.sessionHosts() });
	registerLocalCommand(pi, "sandbox", {
		description: "Choose how commands are sandboxed and see the sandbox's rules",
		handler: async (_args, ctx) => {
			// Without a terminal to draw the panel in (RPC, a one-shot run), the state is printed.
			if (!sandboxPlatform() || !canShowCustomUi(ctx)) {
				ctx.ui.notify(statusLines(ctx).join("\n"), "info");
				return;
			}
			const running = sandboxConfigured();
			// The lists show what the settings files say now; a change made earlier in this session may still wait for a restart.
			let loaded = reloadSandboxSettings();
			let outcome: string | undefined;
			await panelUi(pi.events, ctx.ui).custom<null>((tui, theme, _keybindings, done) => {
				const paint = safeThemePaint(theme);
				const bold = safeThemeBold(theme);
				const state = openSandboxPanel(loaded);
				let frame: { key: string; lines: string[] } | undefined;
				const height = () => boundedDockHeight((tui as { terminal?: { rows?: number } }).terminal?.rows ?? SANDBOX_PANEL_MAX_HEIGHT, SANDBOX_PANEL_MAX_HEIGHT);
				return {
					// One frame per width, tab, row and scroll position: a repaint with nothing changed builds nothing.
					render: (width: number) => {
						const key = `${width}:${height()}:${state.tab}:${state.row}:${state.offset}`;
						if (frame?.key !== key) {
							const lines = renderSandboxPanel({ state, mode: sandboxModeOf(loaded), override: sandboxOverrideOf(loaded), config: state.tab === "config" ? statusLines(ctx) : [], width, height: height() }, paint, bold).map((line) => truncateLine(line, width));
							// The render settles the scroll position, so the key is taken after it.
							frame = { key: `${width}:${height()}:${state.tab}:${state.row}:${state.offset}`, lines };
						}
						return frame.lines;
					},
					handleInput: (data: string) => {
						const key = decodeSandboxPanelKey(data);
						if (!key) return;
						const effect = applySandboxPanelKey(state, key, { mode: sandboxModeOf(loaded), override: sandboxOverrideOf(loaded) }, sandboxConfigRows(height()));
						if (effect?.kind === "close") return done(null);
						if (effect?.kind === "pick") {
							const path = productSettingsPath(homedir());
							try {
								writeSettings(path, applySandboxPick(readSettingsForWrite(path), effect.pick));
								loaded = reloadSandboxSettings();
								outcome = sandboxPickOutcome(effect.pick, running, loaded);
							} catch (error) {
								outcome = `The sandbox setting was not saved: ${(error as Error).message}`;
							}
							return done(null);
						}
						tui.requestRender();
					},
					invalidate: () => {
						frame = undefined;
					},
				};
			});
			if (outcome) ctx.ui.notify(outcome, "info");
		},
	});

	tellSandboxSection(pi);

	let warned = false;
	/** The allowRead entries the user was last told the sandbox leaves out. */
	let toldShadowed = "";
	/** The settings the user was last told the product's lock ignored. */
	let toldIgnored = "";
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		liveCtx = ctx;
		// A session of another directory than the process started in reads that directory's settings.
		useSandboxSettingsFor(ctx.cwd);
		// Settings the product's lock kept out (lib/shell-run/sandbox-settings.ts loadSandboxSettings): say so once per list.
		const ignored = sandboxSettings().product?.ignored.join(", ") ?? "";
		if (ignored && ignored !== toldIgnored) {
			toldIgnored = ignored;
			const message = `The product locks the command sandbox's settings, so these settings were ignored: ${ignored}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		if (!sandboxConfigured()) {
			void stopSandbox();
			// Asked for where the runtime has none: say so once, as a failed start does.
			if (sandboxUnsupported() && !warned) {
				warned = true;
				const message = unsupportedSandboxMessage(sandboxSettings().failIfUnavailable);
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			}
			return;
		}
		const home = homedir();
		const tempDir = privateSessionTempDir(ctx.cwd, ctx.sessionManager.getSessionId());
		scopes = new Map();
		/** What a directory holds that must stay unwritable: its config folder's children and its checkout's files. */
		const protectedIn = (dir: string): string[] => [...protectedConfig(dir), ...checkoutProtectedFiles(dir)];
		// The workspace directories are the same for every scope until they change: read their checkouts once per set.
		let workspaceProtected: { dirs: string[]; files: string[] } | undefined;
		const scopeFor = (dir: string): SandboxScope => {
			let scope = scopes.get(dir);
			if (!scope) {
				if (workspaceProtected?.dirs !== workspace) workspaceProtected = { dirs: workspace, files: workspace.flatMap(protectedIn) };
				scopes.set(dir, (scope = { cwd: dir, writableDirs: [...(tempDir ? [tempDir] : []), ...workspace, ...linkedWorktreeGitDirs(dir)], protectedFiles: [...gateControlFiles(dir, home), ...protectedIn(dir), ...workspaceProtected.files] }));
			}
			return scope;
		};
		// An allowRead entry a Read deny rule covers is left out of the rules (a deny wins): say so once per list.
		const shadowed = shadowedAllowRead(sandboxSettings(), ctx.cwd).join(", ");
		if (shadowed && shadowed !== toldShadowed) {
			toldShadowed = shadowed;
			const message = `The command sandbox leaves out filesystem.allowRead entries that a Read deny rule covers, since a deny wins: ${shadowed}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		// Not awaited: a session must not wait on the proxy. The first command does (lib/shell-run/sandbox.ts).
		void startSandbox({
			cwd: ctx.cwd,
			...(tempDir ? { tempDir } : {}),
			scopeFor,
			// A host the settings do not list (hosts.ts).
			ask: hosts.ask,
			// What a check after a command could not undo, on the session's latest context.
			notice: (message) => {
				if (liveCtx?.hasUI) liveCtx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			},
		}).then((failure) => {
			if (!failure || warned) return;
			warned = true;
			const message = `The command sandbox could not start (${failure}). ${sandboxSettings().failIfUnavailable ? "Shell commands are refused until it can." : "Shell commands run without it."}`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		});
	});
	// `stopSandbox` waits for a start under way.
	pi.on("session_shutdown", () => stopSandbox());
	pi.on("turn_start", (_event, ctx) => {
		liveCtx = ctx;
	});
}

export default feature("sandbox", sandboxExtension);
