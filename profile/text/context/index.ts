/**
 * One Code's part of the first-message context words (the profile's
 * `text.context`): its own ONECODE.md preamble and descriptors, and the name
 * of the instruction-file family in the changed-since-snapshot notice.
 */

import type { ContextText } from "../../../extensions/sdk/profile.ts";

export const context: ContextText = {
	productPreamble: ({ above }) =>
		"# oneCodeMd\n" +
		"The following are One Code-specific instructions, read only by One Code and not by other tools. " +
		`IMPORTANT: they take precedence over the ${above} instructions above and over any default behavior — ` +
		`where they conflict with ${above}, follow these. Follow them exactly as written.`,
	descriptors: {
		product: "One Code-specific instructions, not read by Claude Code",
		productGlobal: "One Code-specific global instructions for all projects, not read by Claude Code",
	},
	instructionsChanged: "CLAUDE.md-family instructions changed",
};
