/**
 * Minimal `which` (pure apart from the access check): the first PATH entry
 * holding an executable of that name, with Windows `PATHEXT` honoured. Shared
 * by the doctor's dependency checks and the shell resolvers
 * (lib/shell-spawn.ts) so "is this on PATH" has one answer.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function whichOnPath(command: string, env: NodeJS.ProcessEnv, platform: string = process.platform): string | undefined {
	if (!command) return undefined;
	// Windows resolves `foo` to `foo.exe`/`foo.cmd` whether or not a directory is
	// spelled (`node_modules/.bin/tsserver` is `…\tsserver.cmd` on disk), so the
	// extension list applies to both forms; elsewhere only the literal name counts.
	// The bare name comes LAST on Windows, and only when it already carries a
	// PATHEXT extension: npm puts three shims per global next to each other
	// (`tsserver`, a POSIX sh script for Git Bash; `tsserver.cmd`; `tsserver.ps1`)
	// and the extensionless one is not a Windows executable — CreateProcess
	// refuses it with ENOENT, which is what every npm-installed language server
	// did on a real Windows machine until 2026-09-19 (findings §22).
	const pathext = platform === "win32" ? (envVar(env, "PATHEXT") ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [];
	const hasPathext = pathext.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
	const extensions = platform === "win32" ? (hasPathext ? ["", ...pathext] : [...pathext, ""]) : [""];
	if (command.includes("/") || command.includes("\\")) {
		return extensions.map((ext) => command + ext).find(isExecutable);
	}
	for (const dir of (envVar(env, "PATH") ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate = join(dir, command + ext);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * Read an environment variable by name regardless of the key's case. Windows
 * spells it `Path`; `process.env` itself answers `env.PATH` there because it
 * is a case-insensitive proxy, but a spread copy (`{ ...process.env, ...extra }`,
 * the shape every spawn with its own variables builds) is a plain object and
 * `copy.PATH` is undefined — so the lookup silently found nothing.
 */
export function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) return direct;
	const upper = name.toUpperCase();
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === upper) return env[key];
	}
	return undefined;
}

export function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
