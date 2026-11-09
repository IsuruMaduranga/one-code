/**
 * What the tool-style extension needs from a profile (types only): the
 * descriptions it puts on pi's built-in file tools in place of pi's own.
 * Read, grep, find and ls keep pi's descriptions untouched.
 */

import type { DescriptionForm } from "../lib/profile/tool-variants.ts";

export interface ToolStyleText {
	/** The write tool's description, by the session's description form. */
	writeDescription(form: DescriptionForm): string;
	/** The edit tool's description, built on pi's own (`base`). */
	editDescription(p: { base: string }): string;
}
