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
	if (command.includes("/") || command.includes("\\")) return isExecutable(command) ? command : undefined;
	const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
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
