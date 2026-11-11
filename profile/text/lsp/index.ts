/**
 * One Code's language-server text (the profile's `text.lsp`): the
 * lsp_diagnostics tool, its results and failures, and the new-diagnostics
 * block (Claude Code's `<new-diagnostics>` shape).
 */

import type { LspText } from "../../../extensions/sdk/profile.ts";

export const lsp: LspText = {
	description:
		"Ask the language server for diagnostics (type errors, warnings) on a file. Reflects the file's current contents. Supported: TypeScript/JavaScript, Python, Go, Rust, Java — plus any language a plugin's .lsp.json configures — when that language's server is installed.",
	params: {
		path: "File to analyse (absolute or workspace-relative)",
		severity: "Minimum severity (default: all)",
	},
};
