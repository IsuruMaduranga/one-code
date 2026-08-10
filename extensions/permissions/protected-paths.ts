/**
 * Protected paths (pure) — Claude Code's list of paths whose *writes* are never
 * auto-approved, in any mode except bypassPermissions.
 *
 * These are not "secret" paths (that list lives in `auto-mode/sensitive.ts` and
 * is about credentials). These are paths that configure the tooling: a write to
 * `.git/hooks`, `.husky`, `.pre-commit-config.yaml`, a shell rc file, or an
 * `.npmrc` plants code that runs on the next commit, install, or shell — and a
 * write to `.claude` reconfigures the agent's own permissions. Being inside the
 * working directory says nothing about whether such a write is safe, which is
 * why containment does not clear them and why an `allow` rule does not either:
 * the check runs before allow rules are evaluated.
 */

import { relative, resolve, sep } from "node:path";

/** Directories whose entire contents are protected. */
const PROTECTED_DIRS = [
	".git",
	".config/git",
	".vscode",
	".idea",
	".husky",
	".cargo",
	".devcontainer",
	".yarn",
	".mvn",
	".claude",
	// One Code's own state dir — the deny-direction twin of protecting `.claude`:
	// as generated state moves here, a write that reconfigures the gate must
	// stay just as guarded in its new home.
	".one-code",
];

/**
 * `.claude/worktrees` is where the agent keeps its own git worktrees, and
 * `.one-code/plans` holds plan-mode documents (rendered to the user, never
 * executed) — ordinary working space rather than configuration.
 */
const PROTECTED_DIR_EXCEPTIONS = [".claude/worktrees", ".one-code/plans"];

const PROTECTED_FILES = new Set([
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_aliases",
	".bash_logout",
	".zshrc",
	".zprofile",
	".zshenv",
	".zlogin",
	".zlogout",
	".profile",
	".envrc",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	".pnp.cjs",
	".pnp.loader.mjs",
	".pnpmfile.cjs",
	"bunfig.toml",
	".bunfig.toml",
	".bazelrc",
	".bazelversion",
	".bazeliskrc",
	".pre-commit-config.yaml",
	"lefthook.yml",
	"lefthook.yaml",
	".lefthook.yml",
	".lefthook.yaml",
	"gradle-wrapper.properties",
	"maven-wrapper.properties",
	".devcontainer.json",
	".ripgreprc",
	"pyrightconfig.json",
	".mcp.json",
	".claude.json",
]);

// `isWritingTool` / `WRITING_TOOLS` live in auto-mode/paths.ts (the shared lower
// layer) so the safety floor and this gate share one source of truth; re-exported
// here for the existing importers (matcher.ts, permissions/index.ts).
export { isWritingTool } from "../auto-mode/paths.ts";

/**
 * Whether a path is protected. Matched on path *segments* so the check works
 * for absolute paths, cwd-relative ones, and any depth of nesting — a
 * `packages/app/.vscode/settings.json` is as protected as a top-level one.
 */
export function isProtectedPath(candidate: string, cwd?: string): boolean {
	const forward = candidate.replace(/\\/g, "/").toLowerCase();
	// Compare relative to cwd when given, so an absolute in-project path and the
	// relative form of the same path behave identically.
	const relativeForm = cwd
		? relative(resolve(cwd), resolve(cwd, candidate)).split(sep).join("/").toLowerCase()
		: forward;
	const forms = [forward, relativeForm].filter(Boolean);

	for (const form of forms) {
		const segments = form.split("/").filter((segment) => segment && segment !== ".");
		if (segments.length === 0) continue;

		const basename = segments[segments.length - 1];
		if (PROTECTED_FILES.has(basename)) return true;

		for (const dir of PROTECTED_DIRS) {
			const dirSegments = dir.split("/");
			for (let i = 0; i + dirSegments.length <= segments.length; i++) {
				if (!dirSegments.every((part, offset) => segments[i + offset] === part)) continue;
				// The match is only protective if something lives *under* the
				// directory — the write target has to be inside it.
				if (i + dirSegments.length >= segments.length) continue;
				const tail = segments.slice(i).join("/");
				if (PROTECTED_DIR_EXCEPTIONS.some((exception) => tail.startsWith(`${exception}/`) || tail === exception)) {
					continue;
				}
				return true;
			}
		}
	}

	return false;
}
