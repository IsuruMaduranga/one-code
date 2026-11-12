/**
 * The names a web-search message points the user at: the key variables, the
 * settings snippet and the settings file. A leaf module (the brand only),
 * because the profile's text names them (extensions/sdk/profile.ts) and must
 * not load the search backends with them.
 */

import { SETTINGS_DISPLAY } from "../../lib/profile/settings-display.ts";

export const BRAVE_KEY_ENV = "BRAVE_SEARCH_API_KEY";
export const TAVILY_KEY_ENV = "TAVILY_API_KEY";
/** The one-line settings snippet both warnings point at: the fix, spelled out. */
export const SETTINGS_SNIPPET = '{ "webSearch": { "apiKeys": { "brave": "<key>" } } }';
export const SETTINGS_FILE = SETTINGS_DISPLAY;
