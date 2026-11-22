/**
 * The process's shell sandbox: Anthropic's sandbox runtime
 * (`@anthropic-ai/sandbox-runtime`: Seatbelt on macOS, bubblewrap on Linux,
 * and a filtering proxy for the network) around each command the model runs.
 *
 * The runtime is one manager per process, so the session's sandbox lives in
 * a process slot (lib/profile/process-state.ts): the sandbox extension starts
 * and stops it with the main session, and every shell tool in the process,
 * an in-process child's included, wraps its commands through it. The package
 * is imported only when a sandbox starts, so a session without one never
 * loads it.
 *
 * The settings are read once per process, at the first question: the tools'
 * schemas are registered before any session starts and must not change
 * under a session.
 */

import { randomBytes } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { processState } from "../profile/process-state.ts";
import { shellQuote } from "../shell/shell-quote.ts";
import { probeSandbox } from "./sandbox-probe.ts";
import { bashSpawn } from "./shell-spawn.ts";
import { isShellToolName } from "./shell-tools.ts";
import { createEndChecks } from "./sandbox-end-checks.ts";
import { commandHosts, isExcludedCommand, loadSandboxSettings, looksLikeBareRepository, pathExists, plantableCommondirs, sandboxCommandFilesystem, sandboxFilesystem, sandboxRuntimeConfig, type SandboxScope, type SandboxSettings } from "./sandbox-settings.ts";

/** One command to wrap. */
export interface SandboxCall {
	cwd: string;
	/** The shell that runs the command inside the sandbox. */
	shell: string;
	/**
	 * The run's own id, under which the runtime files what it denied and
	 * finds the hosts allowed to this one command. The sandboxed command
	 * presents it to the proxy, so it is random and never the tool call's.
	 */
	id: string;
	/** The model's own command: what the runtime reports a denial against. */
	text: string;
}

/**
 * A network connection the proxy has no rule for: true allows it, false
 * refuses it, and a reason refuses it with that text in the command's
 * `<sandbox_violations>` block.
 */
export type SandboxHostAsk = (request: { host: string; port?: number }) => Promise<boolean | { allow: false; reason: string }>;

export interface ActiveSandbox {
	/** The command to hand the shell in place of `command`. */
	wrap(command: string, call: SandboxCall): Promise<string>;
	/** `output` with the runtime's `<sandbox_violations>` block for this run, when it denied something. */
	annotate(id: string, output: string): string;
	/** Let the run `id` reach `hosts` beyond the settings' list; throws on an entry the runtime rejects. */
	allowHosts(id: string, hosts: readonly string[]): void;
	/** The run `id` is over: its host list no longer applies. */
	release(id: string): void;
	/**
	 * The wrapped command of run `id` is over. The runtime counts its wraps
	 * and removes what a command left on disk (bubblewrap's mount points for
	 * paths that did not exist) only once every wrap was ended, so this is
	 * called exactly once per successful `wrap`, with the id that wrap got.
	 */
	ended(id: string): void;
	/** The filesystem rules of a command run in `cwd`, for the prompt: a per-command glob as its pattern, never its expansion. */
	filesystem(cwd: string): ReturnType<typeof sandboxFilesystem>;
}

interface SandboxState {
	settings?: SandboxSettings;
	/** The directory `settings` were read for. */
	settingsCwd?: string;
	active?: ActiveSandbox;
	/** Why the sandbox the settings ask for is not running. */
	unavailable?: string;
	/** A start under way: a command that arrives before it settles waits for it. */
	starting?: Promise<unknown>;
	/**
	 * The hosts the permission gate granted one tool call, by the call's id,
	 * until the call runs. Written by the gate only, never from tool input.
	 */
	grantedHosts?: Map<string, string[]>;
}

const state = (): SandboxState => processState<SandboxState>("shell-run:sandbox", () => ({}));

/** The platforms the runtime sandboxes on (native Windows runs commands unsandboxed, as in Claude Code). */
export function sandboxPlatform(platform: NodeJS.Platform = process.platform): "darwin" | "linux" | undefined {
	return platform === "darwin" || platform === "linux" ? platform : undefined;
}

/** The process's sandbox settings, read once for a directory. */
export function sandboxSettings(): SandboxSettings {
	const slot = state();
	if (!slot.settings) {
		slot.settingsCwd = process.cwd();
		slot.settings = loadSandboxSettings(slot.settingsCwd, homedir());
	}
	return slot.settings;
}

/**
 * A session starts in `cwd`. The settings were read for the directory the
 * process started in; a session of another directory (a resume from the
 * picker) gets its own, so one project's allowances and exclusions never
 * apply in another and a project that turns the sandbox on is heard. The
 * shell tools' schemas were registered before this and keep their shape
 * until the next start.
 */
export function useSandboxSettingsFor(cwd: string): void {
	const slot = state();
	sandboxSettings();
	if (slot.settingsCwd === cwd) return;
	slot.settingsCwd = cwd;
	slot.settings = loadSandboxSettings(cwd, homedir());
}

/** Whether the settings ask for a sandbox on a platform that has one: what the tools' schemas follow. */
export function sandboxConfigured(): boolean {
	return sandboxSettings().enabled && sandboxPlatform() !== undefined;
}

/** Why no sandbox runs on a platform the runtime does not cover. */
export const SANDBOX_UNSUPPORTED = "this platform has no command sandbox";

/** Whether the settings ask for a sandbox on a platform that has none (native Windows). */
export function sandboxUnsupported(platform: NodeJS.Platform = process.platform): boolean {
	return sandboxSettings().enabled && sandboxPlatform(platform) === undefined;
}

/** The running sandbox, or undefined. */
export function activeSandbox(): ActiveSandbox | undefined {
	return state().active;
}

/** Settles when the sandbox's start under way, if any, has ended either way. */
export function sandboxSettled(): Promise<void> {
	return Promise.resolve(state().starting).then(() => undefined, () => undefined);
}

/**
 * Read the settings again after the user changed them in `/sandbox`. Two keys
 * take effect at once, since neither changes a tool's schema nor the running
 * sandbox's rules: whether a sandboxed command skips the prompt, and whether
 * the model may ask to leave the sandbox. Everything else (on or off, the
 * paths, the deny rules' paths, the hosts) holds until the next start, so a
 * deny rule added in `/permissions` binds the gate at once and the sandbox
 * from the next start. Returns what the files now
 * say, so the caller can tell the user what waits for a restart.
 */
export function reloadSandboxSettings(): SandboxSettings {
	const loaded = loadSandboxSettings(state().settingsCwd ?? process.cwd(), homedir());
	// The product's lock report follows the files too, so /sandbox lists a key the lock now ignores at once.
	state().settings = { ...sandboxSettings(), autoAllowBashIfSandboxed: loaded.autoAllowBashIfSandboxed, allowUnsandboxedCommands: loaded.allowUnsandboxedCommands, ...(loaded.product ? { product: loaded.product } : {}) };
	return loaded;
}

/** Why the configured sandbox is not running, when it is not. */
export function sandboxUnavailable(): string | undefined {
	return state().unavailable;
}


/** What {@link startSandbox} is given. */
export interface SandboxStartOptions {
	scopeFor: (cwd: string) => SandboxScope;
	cwd: string;
	tempDir?: string;
	ask: SandboxHostAsk;
	notice?: (message: string) => void;
}

/**
 * Start the session's sandbox. `scopeFor` gives what a command run in a
 * directory may write and must never write; `ask` decides a host the
 * settings do not list; `notice` tells the user what a check after a command
 * could not undo (default: stderr). Returns why it could not start, or
 * undefined.
 */
export function startSandbox(opts: SandboxStartOptions): Promise<string | undefined> {
	const slot = state();
	const start = startRuntime(opts, slot.starting);
	slot.starting = start;
	return start;
}

async function startRuntime(opts: SandboxStartOptions, earlier: Promise<unknown> | undefined): Promise<string | undefined> {
	const slot = state();
	const settings = sandboxSettings();
	// One manager per process: an earlier session's sandbox is stopped first.
	await earlier?.catch(() => undefined);
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime").catch(() => ({ SandboxManager: undefined }));
	if (slot.active) await SandboxManager?.reset().catch(() => undefined);
	slot.active = undefined;
	slot.unavailable = undefined;
	slot.grantedHosts = undefined;
	try {
		if (!SandboxManager) throw new Error("the sandbox runtime could not be loaded");
		if (!SandboxManager.isSupportedPlatform()) throw new Error("this platform has no sandbox");
		const missing = SandboxManager.checkDependencies().errors;
		if (missing.length > 0) throw new Error(missing.join("; "));
		await SandboxManager.initialize(sandboxRuntimeConfig(settings, opts.scopeFor(opts.cwd)), opts.ask);
		// On Linux the dependency check can pass where bubblewrap still cannot start (sandbox-probe.ts): try one command.
		const bash = process.platform === "linux" ? bashSpawn().spawn : undefined;
		if (bash) {
			const failure = await probeSandbox((command) => SandboxManager.wrapWithSandbox(command, bash.shell), bash);
			// The trial was a wrap like any other: end it, or the runtime defers every later cleanup behind it.
			SandboxManager.cleanupAfterCommand();
			if (failure) {
				await SandboxManager.reset().catch(() => undefined);
				throw new Error(failure);
			}
		}
		// The runtime points TMPDIR at a path every user of the machine shares;
		// the session's own private directory replaces it.
		const prefix = opts.tempDir ? `export TMPDIR=${shellQuote(opts.tempDir)}; ` : "";
		// On Linux what the sandbox cannot deny without breaking git is checked when a command ends (sandbox-end-checks.ts).
		const linux = sandboxPlatform() === "linux";
		const checks = createEndChecks(
			{
				cleanup: () => SandboxManager.cleanupAfterCommand(),
				plantableCommondirs: (cwd) => (linux ? plantableCommondirs(cwd) : []),
				looksLikeBareRepository: (dir) => !linux || looksLikeBareRepository(dir),
				exists: pathExists,
				remove: (path) => rmSync(path, { recursive: true, force: true }),
				rename: renameSync,
			},
			opts.notice ?? ((message) => process.stderr.write(`${message}\n`)),
		);
		slot.active = {
			filesystem: (cwd) => sandboxFilesystem(settings, opts.scopeFor(cwd)),
			wrap: async (command, call) => {
				checks.started(call.id, call.cwd);
				try {
					// Built for every wrap: a Linux write-deny glob becomes the files it matches as this command starts.
					return await SandboxManager.wrapWithSandbox(`${prefix}${command}`, call.shell, { filesystem: sandboxCommandFilesystem(settings, opts.scopeFor(call.cwd)) }, undefined, { commandId: call.id, commandText: call.text });
				} catch (error) {
					// No command came back, so no `ended` follows: the run's observation goes with it.
					checks.discard(call.id);
					throw error;
				}
			},
			annotate: (id, output) => SandboxManager.annotateStderrWithSandboxFailures(id, output),
			ended: (id) => checks.ended(id),
			allowHosts: (id, hosts) => SandboxManager.registerCommandNetworkLists(id, { allowedDomains: [...hosts] }),
			release: (id) => SandboxManager.unregisterCommandNetworkLists(id),
		};
		return undefined;
	} catch (error) {
		slot.unavailable = (error as Error).message;
		return slot.unavailable;
	}
}

/** Stop the sandbox and its proxy; nothing of it outlives the session. */
export async function stopSandbox(): Promise<void> {
	const slot = state();
	await slot.starting?.catch(() => undefined);
	slot.starting = undefined;
	slot.grantedHosts = undefined;
	if (!slot.active) return;
	slot.active = undefined;
	try {
		const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
		await SandboxManager.reset();
	} catch {
		// Nothing to stop.
	}
}

/** Why a shell call was not run. */
export type SandboxRefusal =
	/** The sandbox is required (`failIfUnavailable`) and is not running. */
	| { kind: "unavailable"; reason: string }
	/** The sandbox runs every command through a bash, and the machine has none. */
	| { kind: "noBash" }
	/** The call's own host list has an entry the sandbox rejects. */
	| { kind: "hosts"; reason: string };

/** How one shell call runs. */
export type SandboxedCommand =
	/** `command` is what the shell gets; `run` is set when it is the wrapped one. */
	| { command: string; run?: SandboxRun }
	| { refused: SandboxRefusal };

/** One command running inside the sandbox. */
export interface SandboxRun {
	/** `text` with what the sandbox denied this run appended, when it denied something. */
	withViolations(text: string): string;
	/**
	 * The run is over: its host list no longer applies and the runtime may
	 * clean up after it. Safe to call twice.
	 * Whoever runs the command calls it when the command ends, a background
	 * task's owner when the task does.
	 */
	finish(): void;
}

/** One shell tool call, as the model sent it. */
export interface SandboxRequest {
	/** What would run unsandboxed (a worktree session's cd-wrapped line). */
	command: string;
	/** The model's own command, which the user's excluded patterns are matched against. */
	original: string;
	/** The model's `dangerouslyDisableSandbox`, honoured only where the settings allow it. */
	disable: boolean;
	cwd: string;
	/** The bash that runs commands inside the sandbox, or undefined when the machine has none. */
	bash: string | undefined;
	/**
	 * What that bash runs for this call, when the tool's own shell is not bash
	 * (the PowerShell tool's `pwsh -Command '…'` line), built only when the
	 * call is wrapped. Default: `command`.
	 */
	line?: () => string;
	/** The tool call's id: the permission gate grants a call its hosts under it. */
	id: string;
}

/** Whether a call leaves the sandbox: the model asked and may, or the user excluded the command. */
function leavesSandbox(settings: SandboxSettings, call: { disable: boolean; original: string }): boolean {
	return (call.disable && settings.allowUnsandboxedCommands) || isExcludedCommand(call.original, settings.excludedCommands);
}

/**
 * The command a shell tool call runs: wrapped in the session's sandbox unless
 * none is configured, the user excluded the command, or the model asked to
 * leave it and may (the permission gate has judged that request by then,
 * lib/rules/matcher.ts `unsandboxed`).
 */
export async function sandboxedCommand(request: SandboxRequest, platform: NodeJS.Platform = process.platform): Promise<SandboxedCommand> {
	const settings = sandboxSettings();
	/** The sandbox cannot run this command: refused when the user required it, a plain run otherwise. */
	const unavailable = (reason: string): SandboxedCommand => (settings.failIfUnavailable ? { refused: { kind: "unavailable", reason } } : { command: request.command });
	// A platform with no sandbox is an unavailable one: the user who required it gets a refusal, not a silent plain run.
	if (sandboxUnsupported(platform)) return unavailable(SANDBOX_UNSUPPORTED);
	if (!sandboxConfigured()) return { command: request.command };
	const slot = state();
	await slot.starting?.catch(() => undefined);
	const hosts = slot.grantedHosts?.get(request.id) ?? [];
	slot.grantedHosts?.delete(request.id);
	const sandbox = activeSandbox();
	if (!sandbox) return unavailable(sandboxUnavailable() ?? "it has not started");
	if (leavesSandbox(settings, request)) return { command: request.command };
	if (!request.bash) return { refused: { kind: "noBash" } };
	// The command presents this id to the proxy, which finds its hosts by it: 128 random bits, as the runtime requires.
	const id = randomBytes(16).toString("base64url");
	let listed = false;
	if (hosts.length > 0) {
		try {
			sandbox.allowHosts(id, hosts);
			listed = true;
		} catch (error) {
			return { refused: { kind: "hosts", reason: (error as Error).message } };
		}
	}
	let wrapped = false;
	// Each piece of the run's state is consumed before it is acted on, so a step
	// that throws is never repeated by a second call, and the wrap is ended
	// whatever releasing the hosts did.
	const finish = () => {
		try {
			if (listed) {
				listed = false;
				sandbox.release(id);
			}
		} finally {
			if (wrapped) {
				wrapped = false;
				sandbox.ended(id);
			}
		}
	};
	try {
		const command = await sandbox.wrap(request.line?.() ?? request.command, { cwd: request.cwd, shell: request.bash, id, text: request.original });
		wrapped = true;
		return {
			command,
			run: {
				withViolations: (text) => {
					const block = sandbox.annotate(id, "").trim();
					return block ? `${text}\n${block}` : text;
				},
				finish,
			},
		};
	} catch (error) {
		finish();
		throw error;
	}
}

/** A shell call's input, as the permission gate reads it. */
type ShellInput = Record<string, unknown> | undefined;

/** Whether a sandbox runs in this process now. */
const sandboxRuns = (): boolean => sandboxConfigured() && activeSandbox() !== undefined;

/**
 * Whether a shell tool call asks to leave a running sandbox and would be
 * allowed to: what the permission gate judges more strictly
 * (lib/rules/matcher.ts `unsandboxed`).
 */
export function unsandboxedRequest(input: ShellInput): boolean {
	return input?.dangerouslyDisableSandbox === true && sandboxRuns() && sandboxSettings().allowUnsandboxedCommands;
}

/**
 * The hosts a shell call names for itself (`allowed_domains`) where they can
 * take effect: a sandbox runs and the call stays in it. Only auto mode
 * honours them, after its classifier has read them with the command
 * (lib/rules/matcher.ts `commandHosts`); every other mode ignores the list.
 */
export function requestedHosts(input: ShellInput): string[] {
	if (!sandboxRuns() || unsandboxedRequest(input)) return [];
	return commandHosts(input);
}

/**
 * The permission gate's grant of `hosts` to the tool call `toolCallId`, for
 * its one run. The gate calls this after the review that read the list; the
 * shell tool takes it when the call runs.
 */
export function grantCommandHosts(toolCallId: string, hosts: readonly string[]): void {
	if (hosts.length === 0 || !sandboxRuns()) return;
	const slot = state();
	slot.grantedHosts ??= new Map();
	slot.grantedHosts.set(toolCallId, [...hosts]);
}

/**
 * What the permission gate needs to know about one tool call under the
 * sandbox, for `decide()` (lib/rules/matcher.ts `unsandboxed`,
 * `commandHosts`, `sandboxed`). `tool` is the normalized tool name, `subject`
 * the model's own command, and `mode` the permission mode: the hosts a call
 * names count in auto mode only, where the classifier reads them, and for
 * the tools that take the list (the shell tools and monitor). One place, so
 * the main gate, the child bridge and a child's own gate cannot drift apart.
 */
export function sandboxGateFacts(tool: string, input: ShellInput, subject: string, mode: string): { unsandboxed: boolean; hosts: string[]; sandboxed: boolean } {
	const shell = isShellToolName(tool);
	return {
		unsandboxed: shell && unsandboxedRequest(input),
		hosts: mode === "auto" && (shell || tool === "monitor") ? requestedHosts(input) : [],
		sandboxed: tool === "bash" && runsSandboxed(input, subject),
	};
}

/**
 * Whether a bash call will run inside the sandbox and the user's settings
 * let such a command skip the prompt (`autoAllowBashIfSandboxed`):
 * what the permission gate's manual modes read (lib/rules/matcher.ts
 * `sandboxed`). `command` is the model's own command, the one the user's
 * excluded patterns are matched against.
 */
export function runsSandboxed(input: ShellInput, command: string): boolean {
	if (!sandboxRuns()) return false;
	const settings = sandboxSettings();
	return settings.autoAllowBashIfSandboxed && !leavesSandbox(settings, { disable: input?.dangerouslyDisableSandbox === true, original: command });
}

/** A test's sandbox: `settings` as the process's, and `active` as the running one. */
export function setSandboxForTest(settings: SandboxSettings | undefined, active?: ActiveSandbox, unavailable?: string): void {
	const slot = state();
	slot.settings = settings;
	slot.settingsCwd = settings ? process.cwd() : undefined;
	slot.active = active;
	slot.unavailable = unavailable;
	slot.starting = undefined;
	slot.grantedHosts = undefined;
}
