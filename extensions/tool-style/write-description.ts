/**
 * The write tool's model-facing description: Claude Code's Write text (pure).
 *
 * pi's own write tool runs underneath (tool-style/index.ts); only the
 * description is Claude Code's, short on frontier and workhorse, long on cheap
 * and tiny (lib/tool-variants.ts), with One Code's tool names. "Overwriting an
 * existing file you haven't read will fail" holds here: the file tracker
 * refuses it (file-tracker/tracker.ts). Read and edit keep pi's descriptions,
 * because Claude Code's describe a different call shape (`file_path`,
 * numbered lines, `old_string`); edit's gets the read rule appended
 * (`editDescription`).
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

export const WRITE_SHORT_DESCRIPTION = `Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already read. Overwriting an existing file you haven't read will fail. For partial changes, use edit instead.`;

export const WRITE_LONG_DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

export function writeDescription(form: DescriptionForm): string {
	return form === "long" ? WRITE_LONG_DESCRIPTION : WRITE_SHORT_DESCRIPTION;
}

/**
 * pi's edit description plus the rule the file tracker enforces, which pi's
 * text does not state (write's does). Without it, GPT-6 models read with `cat`
 * and met the refusal first (2026-10-04 Codex self-test: 16 refused edits).
 */
export function editDescription(base: string): string {
	return `${base} The file must have been read in this conversation, with the read tool or a shell command whose output showed the whole file, or the edit is refused; if it changed on disk since, read it again first.`;
}
