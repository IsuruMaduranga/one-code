/**
 * The product's user settings file as messages show it. A leaf module (the
 * brand only): text that names the file must not load the settings reader
 * (product-settings.ts) with it.
 */

import { brand } from "./brand.mjs";

/** `~/.onecode/settings.json` under One Code's brand. */
export const SETTINGS_DISPLAY = `~/${brand.stateDir}/settings.json`;
