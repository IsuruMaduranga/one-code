/**
 * Session scratchpad — Claude Code's designated temp-files directory.
 *
 * Claude Code puts one under `<tmp>/claude-<uid>/<project-slug>/<session-id>/scratchpad`
 * and tells the model (via a system-prompt section) to use it for everything
 * that would otherwise land in `/tmp` or leak into the project. The path is
 * per-session, so parallel sessions on one project never collide.
 *
 * Three extensions need the same path (system-prompt renders the section,
 * permissions and the workflow gate allow writes into it), and jiti isolates
 * module state — so each re-derives it through `sessionScratchpadDir`.
 */

import { realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { findGitRoot } from "./git.ts";
import { projectSlug } from "./memory.ts";

/** Pure core, testable: the Claude Code path shape. */
export function scratchpadDir(
	tmpRoot: string,
	uid: number | undefined,
	projectRoot: string,
	sessionId: string,
): string {
	const owner = uid === undefined ? "claude" : `claude-${uid}`;
	return join(tmpRoot, owner, projectSlug(projectRoot), sessionId, "scratchpad");
}

/**
 * `/tmp` resolved through its symlink (macOS: `/private/tmp`), so the path in
 * the prompt, the path the permission check compares, and the case-folded
 * resolved subject all name the same real location. Falls back to os.tmpdir()
 * where /tmp does not exist.
 */
export function resolveTmpRoot(): string {
	try {
		return realpathSync("/tmp");
	} catch {
		return os.tmpdir();
	}
}

/** The session's scratchpad, derived the same way by every consumer. */
export function sessionScratchpadDir(cwd: string, sessionId: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	return scratchpadDir(resolveTmpRoot(), uid, findGitRoot(cwd) ?? cwd, sessionId);
}

/** Claude Code's Scratchpad Directory prompt section, verbatim (see payload.json). */
export function scratchpadPromptSection(dir: string): string {
	return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can generally be used without permission prompts.`;
}
