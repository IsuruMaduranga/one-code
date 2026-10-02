/**
 * The startup questions' remembered "No" (replaced-builtins.ts,
 * compaction-keep.ts): a key set to true in `~/.onecode/settings.json`.
 */

import os from "node:os";
import { oneCodeSettingsPath, readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";

/** Whether the user answered "No" to the question kept under `key`; a malformed settings file reads as not declined. */
export function declined(key: string): boolean {
	try {
		return readSettingsForWrite(oneCodeSettingsPath(os.homedir()))[key] === true;
	} catch {
		return false;
	}
}

/** Remember a "No" to the question kept under `key`. */
export function recordDeclined(key: string): void {
	const path = oneCodeSettingsPath(os.homedir());
	writeSettings(path, { ...readSettingsForWrite(path), [key]: true });
}
