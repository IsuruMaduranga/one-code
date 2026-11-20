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

import { homedir } from "node:os";
import { processState } from "../profile/process-state.ts";
import { isExcludedCommand, loadSandboxSettings, sandboxFilesystem, sandboxRuntimeConfig, type SandboxScope, type SandboxSettings } from "./sandbox-settings.ts";

/** One command to wrap. */
export interface SandboxCall {
	cwd: string;
	/** The shell that runs the command inside the sandbox. */
	shell: string;
	/** A unique id (the tool call's), under which the runtime files what it denied. */
	id: string;
}

/** A network connection the proxy has no rule for. */
export type SandboxHostAsk = (request: { host: string; port?: number }) => Promise<boolean>;

export interface ActiveSandbox {
	settings: SandboxSettings;
	/** The directory `TMPDIR` names inside the sandbox, when the session has a private one. */
	tempDir?: string;
	/** The command to hand the shell in place of `command`. */
	wrap(command: string, call: SandboxCall): Promise<string>;
	/** `output` with the runtime's `<sandbox_violations>` block for this call, when it denied something. */
	annotate(id: string, output: string): string;
	/** The filesystem rules of a command run in `cwd`, for the prompt. */
	filesystem(cwd: string): ReturnType<typeof sandboxFilesystem>;
}

interface SandboxState {
	settings?: SandboxSettings;
	active?: ActiveSandbox;
	/** Why the sandbox the settings ask for is not running. */
	unavailable?: string;
	/** A start under way: a command that arrives before it settles waits for it. */
	starting?: Promise<unknown>;
}

const state = (): SandboxState => processState<SandboxState>("shell-run:sandbox", () => ({}));

/** The platforms the runtime sandboxes on (native Windows runs commands unsandboxed, as in Claude Code). */
export function sandboxPlatform(platform: NodeJS.Platform = process.platform): "darwin" | "linux" | undefined {
	return platform === "darwin" || platform === "linux" ? platform : undefined;
}

/** The process's sandbox settings, read once. */
export function sandboxSettings(): SandboxSettings {
	const slot = state();
	slot.settings ??= loadSandboxSettings(process.cwd(), homedir());
	return slot.settings;
}

/** Whether the settings ask for a sandbox on a platform that has one: what the tools' schemas follow. */
export function sandboxConfigured(): boolean {
	return sandboxSettings().enabled && sandboxPlatform() !== undefined;
}

/** The running sandbox, or undefined. */
export function activeSandbox(): ActiveSandbox | undefined {
	return state().active;
}

/** Why the configured sandbox is not running, when it is not. */
export function sandboxUnavailable(): string | undefined {
	return state().unavailable;
}

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Start the session's sandbox. `scopeFor` gives what a command run in a
 * directory may write and must never write; `ask` decides a host the
 * settings do not list. Returns why it could not start, or undefined.
 */
export function startSandbox(opts: { scopeFor: (cwd: string) => SandboxScope; cwd: string; tempDir?: string; ask: SandboxHostAsk }): Promise<string | undefined> {
	const slot = state();
	const start = start1(opts, slot.starting);
	slot.starting = start;
	return start;
}

async function start1(opts: { scopeFor: (cwd: string) => SandboxScope; cwd: string; tempDir?: string; ask: SandboxHostAsk }, earlier: Promise<unknown> | undefined): Promise<string | undefined> {
	const slot = state();
	const settings = sandboxSettings();
	// One manager per process: an earlier session's sandbox is stopped first.
	await earlier?.catch(() => undefined);
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime").catch(() => ({ SandboxManager: undefined }));
	if (slot.active) await SandboxManager?.reset().catch(() => undefined);
	slot.active = undefined;
	slot.unavailable = undefined;
	try {
		if (!SandboxManager) throw new Error("the sandbox runtime could not be loaded");
		if (!SandboxManager.isSupportedPlatform()) throw new Error("this platform has no sandbox");
		const missing = SandboxManager.checkDependencies().errors;
		if (missing.length > 0) throw new Error(missing.join("; "));
		await SandboxManager.initialize(sandboxRuntimeConfig(settings, opts.scopeFor(opts.cwd)), opts.ask);
		// The runtime points TMPDIR at a path every user of the machine shares;
		// the session's own private directory replaces it.
		const prefix = opts.tempDir ? `export TMPDIR=${shellQuote(opts.tempDir)}; ` : "";
		slot.active = {
			settings,
			...(opts.tempDir ? { tempDir: opts.tempDir } : {}),
			filesystem: (cwd) => sandboxFilesystem(settings, opts.scopeFor(cwd)),
			wrap: (command, call) =>
				SandboxManager.wrapWithSandbox(`${prefix}${command}`, call.shell, { filesystem: sandboxFilesystem(settings, opts.scopeFor(call.cwd)) }, undefined, { commandId: call.id, commandText: command }),
			annotate: (id, output) => {
				try {
					return SandboxManager.annotateStderrWithSandboxFailures(id, output);
				} finally {
					SandboxManager.cleanupAfterCommand();
				}
			},
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
	if (!slot.active) return;
	slot.active = undefined;
	try {
		const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
		await SandboxManager.reset();
	} catch {
		// Nothing to stop.
	}
}

/** How one shell call runs. */
export type SandboxedCommand =
	/** `command` is what the shell gets; `sandbox` is set when it is the wrapped one. */
	| { command: string; sandbox?: ActiveSandbox }
	/** Refused: the sandbox is required (`failIfUnavailable`) and is not running, or it cannot run this shell. */
	| { refused: { kind: "unavailable"; reason: string } | { kind: "powershell" } };

/** One shell tool call, as the model sent it. */
export interface SandboxRequest {
	/** What would run unsandboxed (a worktree session's cd-wrapped line). */
	command: string;
	/** The model's own command, which the user's excluded patterns are matched against. */
	original: string;
	/** The model's `dangerouslyDisableSandbox`, honoured only where the settings allow it. */
	disable: boolean;
	cwd: string;
	/** The bash that runs it, or undefined for a shell the sandbox cannot run (PowerShell). */
	bash: string | undefined;
	id: string;
}

/**
 * The command a shell tool call runs: wrapped in the session's sandbox unless
 * none is configured, the user excluded the command, or the model asked to
 * leave it and may (the permission gate has judged that request by then,
 * lib/rules/matcher.ts `unsandboxed`).
 */
export async function sandboxedCommand(request: SandboxRequest): Promise<SandboxedCommand> {
	if (!sandboxConfigured()) return { command: request.command };
	const settings = sandboxSettings();
	await state().starting?.catch(() => undefined);
	const sandbox = activeSandbox();
	if (!sandbox) return settings.failIfUnavailable ? { refused: { kind: "unavailable", reason: sandboxUnavailable() ?? "it has not started" } } : { command: request.command };
	if (request.disable && settings.allowUnsandboxedCommands) return { command: request.command };
	if (isExcludedCommand(request.original, settings.excludedCommands)) return { command: request.command };
	if (!request.bash) return { refused: { kind: "powershell" } };
	return { command: await sandbox.wrap(request.command, { cwd: request.cwd, shell: request.bash, id: request.id }), sandbox };
}

/** `text` with what the sandbox denied this call appended, when it denied something. */
export function withSandboxViolations(text: string, sandbox: ActiveSandbox | undefined, id: string): string {
	if (!sandbox) return text;
	const block = sandbox.annotate(id, "").trim();
	return block ? `${text}\n${block}` : text;
}

/**
 * Whether a shell tool call asks to leave a running sandbox and would be
 * allowed to: what the permission gate judges more strictly
 * (lib/rules/matcher.ts `unsandboxed`).
 */
export function unsandboxedRequest(input: Record<string, unknown> | undefined): boolean {
	return input?.dangerouslyDisableSandbox === true && sandboxConfigured() && activeSandbox() !== undefined && sandboxSettings().allowUnsandboxedCommands;
}

/** A test's sandbox: `settings` as the process's, and `active` as the running one. */
export function setSandboxForTest(settings: SandboxSettings | undefined, active?: ActiveSandbox, unavailable?: string): void {
	const slot = state();
	slot.settings = settings;
	slot.active = active;
	slot.unavailable = unavailable;
	slot.starting = undefined;
}
