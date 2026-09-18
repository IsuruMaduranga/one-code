/**
 * Session scratchpad — a designated temp-files directory.
 *
 * The shape follows Claude Code's (`<tmp>/<owner>/<project-slug>/<session-id>/scratchpad`),
 * but the owner segment carries One Code's name, not Claude Code's, so a machine
 * running both products never interleaves their scratchpads under one owner dir
 * (distribution review 2026-09-09, H2). We tell the model (via a system-prompt
 * section) to use it for everything that would otherwise land in `/tmp` or leak
 * into the project. The path is per-session, so parallel sessions on one project
 * never collide.
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

/** Pure core, testable: Claude Code's path shape under a One Code-named owner dir. */
export function scratchpadDir(
	tmpRoot: string,
	uid: number | undefined,
	projectRoot: string,
	sessionId: string,
): string {
	const owner = uid === undefined ? "onecode" : `onecode-${uid}`;
	return join(tmpRoot, owner, projectSlug(projectRoot), sessionId, "scratchpad");
}

/**
 * The temp root in its resolved spelling, so the path in the prompt, the path
 * the permission check compares, and the resolved subject all name the same
 * real location: `/tmp` through its symlink (macOS: `/private/tmp`), and on
 * Windows — which has no `/tmp`; `os.tmpdir()` is `%TEMP%`, Claude Code's own
 * choice there — `%TEMP%` through its 8.3 short names, which Windows often
 * spells it with (`C:\Users\RUNNER~1\…`, `ISURUW~1` for a long user name).
 * A write's subject arrives realpath'd to the long name, so a scratchpad dir
 * kept in the short spelling never contained anything (the runner showed it,
 * findings §22). Falls back to the spelling as given where resolution fails.
 */
function resolveTmpRoot(): string {
	if (process.platform === "win32") {
		try {
			return realpathSync.native(os.tmpdir());
		} catch {
			return os.tmpdir();
		}
	}
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
