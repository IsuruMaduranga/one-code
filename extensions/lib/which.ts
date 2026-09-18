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
	const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	if (command.includes("/") || command.includes("\\")) {
		return extensions.map((ext) => command + ext).find(isExecutable);
	}
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate = join(dir, command + ext);
			if (isExecutable(candidate)) return candidate;
		}
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
