/**
 * The startup questions' remembered "No" (replaced-builtins.ts,
 * compaction-keep.ts): a key set to true in `~/.onecode/settings.json`.
 */

import os from "node:os";
import { productSettingsPath, readSettingsForWrite, writeSettings } from "../../lib/profile/product-settings.ts";

/** Whether the user answered "No" to the question kept under `key`; a malformed settings file reads as not declined. */
export function declined(key: string): boolean {
	try {
		return readSettingsForWrite(productSettingsPath(os.homedir()))[key] === true;
	} catch {
		return false;
	}
}

/** Remember a "No" to the question kept under `key`. */
export function recordDeclined(key: string): void {
	const path = productSettingsPath(os.homedir());
	writeSettings(path, { ...readSettingsForWrite(path), [key]: true });
}
