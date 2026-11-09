/**
 * The process-wide slot that pins the config mode (mode.ts), with no value
 * imports, so a test setup file can pin it before anything loads without loading the
 * provider's helpers ahead of a test file's mocks (profile/test/setup.ts).
 */
import type { ConfigMode } from "./mode.ts";

const MODE_SLOT = Symbol.for("one-code:config-mode");
const slot = globalThis as { [MODE_SLOT]?: ConfigMode };

/** The pinned mode, or undefined before the first read. */
export function pinnedConfigMode(): ConfigMode | undefined {
	return slot[MODE_SLOT];
}

/** Pins `mode` for the rest of the process. */
export function pinConfigMode(mode: ConfigMode): ConfigMode {
	return (slot[MODE_SLOT] = mode);
}

export function resetConfigModeForTest(mode?: ConfigMode): void {
	if (mode) slot[MODE_SLOT] = mode;
	else delete slot[MODE_SLOT];
}
