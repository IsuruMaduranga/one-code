/**
 * What the tool-style extension needs from a profile (types only): the
 * descriptions it puts on pi's built-in file tools in place of pi's own.
 * Read, grep, find and ls keep pi's descriptions untouched.
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";
import type { LiveTools } from "../lib/live-tools.ts";

export interface ToolStyleText {
	/** The write tool's description, by the session's description form. */
	writeDescription(form: DescriptionForm, live: LiveTools): string;
	/** The edit tool's description, built on pi's own (`base`). */
	editDescription(p: { base: string }): string;
}
