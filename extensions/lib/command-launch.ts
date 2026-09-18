/**
 * How to spawn a user-named command on this platform (pure apart from the
 * PATH lookup it is given). For every bare `spawn(command, args)` of a command
 * the user or a config names — a language server, `$EDITOR` — never for the
 * shell tools, which go through lib/shell-spawn.ts.
 *
 * On Windows an npm-installed tool is a `.cmd` shim
 * (`typescript-language-server.cmd`, VS Code's `code.cmd`): `whichOnPath`
 * finds it through PATHEXT, but a bare `spawn(command)` does not — libuv tries
 * the name and `.com`/`.exe` only, so the spawn fails with ENOENT (findings
 * §22) — and Node refuses to run a batch file without a shell anyway (20.12+,
 * CVE-2024-27980). Such a shim is started through `cmd.exe /d /s /c` with the
 * command line quoted the way Node's own `shell: true` does, and the arguments
 * passed verbatim so Node does not quote them a second time. Anything that
 * resolves to a real executable, or does not resolve at all (the caller's
 * ENOENT handling then applies — lsp/install-hints.ts for servers), is spawned
 * as given. Elsewhere the launch is the command and arguments unchanged.
 */

import { system32Path } from "./paths.ts";
import { whichOnPath } from "./which.ts";

export interface CommandLaunch {
	command: string;
	args: string[];
	/** Set for a cmd.exe launch: the single command-line argument is already quoted. */
	windowsVerbatimArguments?: boolean;
}

export interface CommandLaunchOptions {
	platform?: string;
	which?: (command: string, env: NodeJS.ProcessEnv, platform: string) => string | undefined;
	/** The environment `cmd.exe` is located from (`SystemRoot`); defaults to the process environment. */
	systemEnv?: Record<string, string | undefined>;
}

/** A batch-file shim, by extension (the filesystem folds case; PATHEXT spells them upper-case). */
export function isBatchFile(path: string): boolean {
	return /\.(cmd|bat)$/i.test(path);
}

/**
 * One argument for a cmd.exe command line: quoted when it holds whitespace or
 * a cmd metacharacter, inner quotes escaped for the program the shim runs.
 */
export function quoteForCmd(arg: string): string {
	if (arg === "") return '""';
	if (!/[\s"&|<>^()]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '\\"')}"`;
}

export function commandLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, opts: CommandLaunchOptions = {}): CommandLaunch {
	const platform = opts.platform ?? process.platform;
	if (platform !== "win32") return { command, args };
	const resolved = (opts.which ?? whichOnPath)(command, env, platform);
	if (!resolved) return { command, args };
	if (!isBatchFile(resolved)) return { command: resolved, args };
	const line = [resolved, ...args].map(quoteForCmd).join(" ");
	return {
		command: system32Path("cmd.exe", opts.systemEnv ?? env),
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}
