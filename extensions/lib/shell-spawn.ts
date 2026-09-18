/**
 * Which shell One Code spawns, and how — the one place that knows about Git
 * Bash on Windows and about PowerShell.
 *
 * Claude Code's shape (findings §22, docs/decisions/windows.md): Git for
 * Windows is optional. When a bash is available it drives the `bash` tool,
 * hooks and background shells; `CLAUDE_CODE_GIT_BASH_PATH` (process env, or
 * Claude Code's user-settings `env` block) names a custom bash and is ignored
 * with a warning when it is not a bash/sh binary (CC 2.1.219). PowerShell is
 * `pwsh.exe` then `powershell.exe` on Windows (pi's own resolution), and a
 * `pwsh` on PATH elsewhere — which is how the tool is developed and tested on
 * this Mac (plan §Open questions 2). The argument list is pi's, copied because
 * pi does not export the constant: `-NoProfile -NonInteractive
 * -ExecutionPolicy Bypass -Command`, so the three safety flags are never lost.
 *
 * Resolution goes through pi's exported `getShellConfig` / `getPowerShellConfig`
 * so a bash found here is the same bash pi's own bash tool runs. Both
 * resolvers are injectable for tests (`platform`, `env`, `exists`, `fallback`).
 *
 * `createPowerShellOperations` supplies the spawn for pi's
 * `createPowerShellToolDefinition(cwd, { operations })`: pi's own local
 * operations throw off Windows, so the schema, cwd handling, truncation and
 * rendering stay pi's while the process model is ours (spawn, stream both
 * pipes, process-tree kill on abort/timeout, wait for exit) — the same ~60
 * lines pi runs on Windows, with the same error strings the tool formats.
 */

import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { getPowerShellConfig, getShellConfig } from "@earendil-works/pi-coding-agent";
import { readSettingsEnv } from "./claude-settings.ts";
import { detachedSpawnOptions, killProcessTree, waitForChildExit } from "./process-tree.ts";
import { whichOnPath } from "./which.ts";

/** How to start a shell for one command line. */
export interface ShellSpawn {
	shell: string;
	args: string[];
	/**
	 * pi's legacy-WSL form (`C:\Windows\System32\bash.exe`): the command goes in
	 * on stdin (`bash -s`) instead of as an argument. Default: argv.
	 */
	commandTransport?: "argv" | "stdin";
}

/** pi's PowerShell argument list (utils/shell.ts `POWERSHELL_ARGS`, not exported). */
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** pi's UTF-8 output prefix for PowerShell (core/tools/powershell.ts), so Windows PowerShell 5.1 does not emit UTF-16. */
export const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export const GIT_BASH_PATH_VAR = "CLAUDE_CODE_GIT_BASH_PATH";

// ---------------------------------------------------------------------------
// bash

/** A path names a bash or sh binary — `bash`, `sh`, `bash.exe`, `sh.exe`, any case (CC 2.1.219's check). */
export function isBashBinaryName(path: string): boolean {
	const name = basename(path.replace(/\\/g, "/")).toLowerCase();
	return name === "bash" || name === "sh" || name === "bash.exe" || name === "sh.exe";
}

export interface GitBashOverride {
	path: string;
	source: "env" | "settings";
}

/** The user's `CLAUDE_CODE_GIT_BASH_PATH`, process env first, then Claude Code's user-settings `env` block. */
export function gitBashOverride(
	env: NodeJS.ProcessEnv = process.env,
	settingsEnv: Record<string, string> = {},
): GitBashOverride | undefined {
	const fromEnv = env[GIT_BASH_PATH_VAR]?.trim();
	if (fromEnv) return { path: fromEnv, source: "env" };
	const fromSettings = settingsEnv[GIT_BASH_PATH_VAR]?.trim();
	if (fromSettings) return { path: fromSettings, source: "settings" };
	return undefined;
}

export interface BashResolveInput {
	env?: NodeJS.ProcessEnv;
	/** Claude Code's settings `env` block (user scope only — lib/claude-settings.ts `readSettingsEnv`). */
	settingsEnv?: Record<string, string>;
	exists?: (path: string) => boolean;
	/** pi's `getShellConfig`; injectable so tests never depend on this machine's shells. */
	fallback?: (customShellPath?: string) => ShellSpawn;
}

export interface BashResolution {
	/** Undefined when no bash exists (Windows without Git for Windows). */
	spawn?: ShellSpawn;
	/** An override that was ignored, and why — surfaced to the user once. */
	warning?: string;
	/** Why no bash could be found, in pi's own words. */
	error?: string;
}

export function resolveBashSpawn(input: BashResolveInput = {}): BashResolution {
	const exists = input.exists ?? existsSync;
	const fallback = input.fallback ?? ((custom?: string) => getShellConfig(custom) as ShellSpawn);
	const override = gitBashOverride(input.env, input.settingsEnv);
	let warning: string | undefined;
	if (override) {
		const where = override.source === "env" ? `${GIT_BASH_PATH_VAR}` : `${GIT_BASH_PATH_VAR} (settings.json env)`;
		if (!isBashBinaryName(override.path)) {
			warning = `${where} ignored: "${override.path}" is not a bash or sh binary.`;
		} else if (!exists(override.path)) {
			warning = `${where} ignored: "${override.path}" does not exist.`;
		} else {
			try {
				return { spawn: fallback(override.path) };
			} catch (error) {
				warning = `${where} ignored: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}
	try {
		return { spawn: fallback(), warning };
	} catch (error) {
		return { warning, error: error instanceof Error ? error.message : String(error) };
	}
}

let cachedBash: BashResolution | undefined;

/**
 * The bash this extension spawns, resolved once per module instance (pi's
 * Windows lookup runs `where`, and hooks resolve on every tool call). The
 * resolution reads Claude Code's user-settings `env` block itself, so every
 * consumer — bash tool, hooks, monitor, PowerShell fallback — sees the same
 * `CLAUDE_CODE_GIT_BASH_PATH`. Note the cache is per extension file: jiti
 * gives each extension its own copy of this module (findings §3), so this is
 * a memo, never a cross-extension channel — each extension resolves once.
 */
export function bashSpawn(): BashResolution {
	cachedBash ??= resolveBashSpawn({ settingsEnv: readSettingsEnv(homedir()) });
	return cachedBash;
}

/** The resolved bash, or a throw naming the fix (only reachable on Windows without Git for Windows). */
export function bashSpawnOrThrow(): ShellSpawn {
	const resolved = bashSpawn();
	if (!resolved.spawn) throw new Error(resolved.error ?? "No bash shell found.");
	return resolved.spawn;
}

/** Test seam. */
export function resetShellSpawnCache(): void {
	cachedBash = undefined;
	cachedPowerShell = undefined;
}

// ---------------------------------------------------------------------------
// PowerShell

export interface PowerShellResolveInput {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** PATH lookup (lib/which.ts `whichOnPath`); injectable for tests. */
	which?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
	/** pi's `getPowerShellConfig` (Windows only); injectable for tests. */
	windowsFallback?: () => ShellSpawn;
}

/** pi's resolver on Windows (`pwsh.exe` then `powershell.exe`); the first executable `pwsh` on PATH elsewhere. */
export function resolvePowerShellSpawn(input: PowerShellResolveInput = {}): ShellSpawn | undefined {
	const platform = input.platform ?? process.platform;
	if (platform === "win32") {
		try {
			return (input.windowsFallback ?? (() => getPowerShellConfig() as ShellSpawn))();
		} catch {
			return undefined;
		}
	}
	const pwsh = (input.which ?? ((cmd, env) => whichOnPath(cmd, env, platform)))("pwsh", input.env ?? process.env);
	return pwsh ? { shell: pwsh, args: [...POWERSHELL_ARGS] } : undefined;
}

let cachedPowerShell: { spawn: ShellSpawn | undefined } | undefined;

/** The PowerShell this process spawns, resolved once per process. */
export function powerShellSpawn(): ShellSpawn | undefined {
	cachedPowerShell ??= { spawn: resolvePowerShellSpawn() };
	return cachedPowerShell.spawn;
}

/** Whether the resolved PowerShell is Windows PowerShell 5.1 (`powershell.exe`) or PowerShell 7+ (`pwsh`). */
export function powerShellEdition(spawnSpec: ShellSpawn | undefined): "core" | "desktop" | "unknown" {
	if (!spawnSpec) return "unknown";
	const name = basename(spawnSpec.shell.replace(/\\/g, "/")).toLowerCase();
	if (name === "pwsh" || name === "pwsh.exe") return "core";
	if (name === "powershell.exe" || name === "powershell") return "desktop";
	return "unknown";
}

// ---------------------------------------------------------------------------
// spawning

/**
 * Start `command` under `spec`. argv transport appends the command to the
 * shell's arguments (`bash -c <cmd>`, `pwsh … -Command <cmd>`); stdin transport
 * writes it to the child's stdin (pi's legacy-WSL bash), which needs stdin
 * piped — callers that must feed their own stdin (hooks) reject that form.
 */
export function spawnShellCommand(spec: ShellSpawn, command: string, options: SpawnOptions): ChildProcess {
	if (spec.commandTransport === "stdin") {
		const stdio = Array.isArray(options.stdio) ? ["pipe", ...options.stdio.slice(1)] : ["pipe", "pipe", "pipe"];
		const child = spawn(spec.shell, spec.args, { ...options, stdio: stdio as SpawnOptions["stdio"], windowsHide: true });
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
		return child;
	}
	return spawn(spec.shell, [...spec.args, command], { ...options, windowsHide: true });
}

// ---------------------------------------------------------------------------
// PowerShell operations for pi's tool definition

/** pi's `BashOperations` shape (core/tools/bash.ts), spelled locally so this module has one pi import site. */
export interface ShellOperations {
	exec: (
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
	) => Promise<{ exitCode: number | null }>;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/** pi's timeout validation (seconds → ms), same messages. */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	const ms = timeout * 1000;
	if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	return ms;
}

/**
 * Operations for `createPowerShellToolDefinition(cwd, { operations })` backed
 * by the PowerShell `resolve()` names. Mirrors pi's local shell operations
 * (spawn, stream, kill the tree on abort/timeout, wait) with pi's error strings
 * — `aborted`, `timeout:<seconds>` — which the tool definition formats.
 */
export function createPowerShellOperations(resolve: () => ShellSpawn | undefined = powerShellSpawn): ShellOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) throw new Error("aborted");
			const spec = resolve();
			if (!spec) {
				throw new Error(
					process.platform === "win32"
						? "No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH."
						: "No PowerShell executable found. Install PowerShell 7 (pwsh) and put it on PATH.",
				);
			}
			try {
				await access(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`);
			}
			const child = spawnShellCommand(spec, `${POWERSHELL_UTF8_PREFIX}${command}`, {
				cwd,
				...detachedSpawnOptions(),
				env: env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let timedOut = false;
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => killProcessTree(child, "SIGKILL");
			try {
				if (timeoutMs !== undefined) {
					timer = setTimeout(() => {
						timedOut = true;
						killProcessTree(child, "SIGKILL");
					}, timeoutMs);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				const { code: exitCode } = await waitForChildExit(child);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
