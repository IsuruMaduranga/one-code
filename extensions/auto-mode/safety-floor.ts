/**
 * Auto mode's deterministic floor for writes to the gate's own controls (pure
 * apart from fs reads during path resolution).
 *
 * The classifier's hard-deny rules forbid tampering with permission settings,
 * but a rule the classifier enforces is only as strong as the classifier — a
 * weak model, or one talked around, could approve the one write that disables
 * every check after it. So writes to the files the gate is *made of* never
 * reach the classifier at all: interactively they always prompt the user, and
 * non-interactively they block.
 *
 * This is the deny-direction complement of the shell pre-gate, and the same
 * asymmetry applies inverted: the pre-gate may only ever say "safe" because a
 * gap there must cost a classifier call rather than become a bypass; this
 * floor may only ever say "stop" because a gap here merely falls through to
 * the classifier, which retains its tampering rules. Neither list has to be
 * complete to be sound — a `sed -i` on settings.json that the shell evidence
 * does not model as a write is the classifier's to catch, as today.
 *
 * The target list is deliberately exact files, not directories: ~/.claude also
 * holds memory and skills that the agent writes routinely, and a floor that
 * fires on routine work teaches the user to approve without reading.
 */

import { analyzeShellCommand } from "./shell-analysis.ts";
import { autoModeSettingsPaths } from "./config.ts";
import { oneCodeProjectSettingsPath } from "../lib/one-code-settings.ts";
import { claudeJsonPath } from "../lib/paths.ts";
import { isWritingTool, resolveForContainment, toAbsolute } from "./paths.ts";

/** Case-fold the same way resolveForContainment's output is folded. */
function fold(path: string): string {
	const forward = path.replace(/\\/g, "/");
	return process.platform === "linux" ? forward : forward.toLowerCase();
}

/**
 * Any `.claude/settings.json` or `.claude/settings.local.json`, wherever it
 * lives: the session reads them from cwd, but another checkout or worktree of
 * the same repo feeds other sessions, and prompting on a write to one of those
 * costs one question.
 */
const SETTINGS_TAIL = /\/\.claude\/settings(\.local)?\.json$/;

/**
 * One Code's own settings files — the global `~/.onecode/settings.json` and the
 * per-repo `~/.onecode/projects/<slug>/settings.json`, wherever `.onecode`
 * lives. Both now carry `permissions.allow` rules that `loadPermissionSettings`
 * reads and that bypass the classifier, so a write to either is a gate-control
 * write and must hit this floor rather than the auto-mode classifier (the global
 * file is also reached via `autoModeSettingsPaths`; this covers the per-repo one,
 * which that list never includes, and both under any checkout).
 */
const ONECODE_SETTINGS_TAIL = /\/\.onecode\/(projects\/[^/]+\/)?settings\.json$/;

function safetyControlFiles(home: string, oneCodeProjectSettings?: string): string[] {
	return [
		// autoMode + user permission rules, and the managed-settings paths (the
		// global ~/.onecode/settings.json here honours ONECODE_STATE_DIR).
		...autoModeSettingsPaths(home),
		// Claude Code's global state file also carries permission configuration;
		// claudeJsonPath honours CLAUDE_CONFIG_DIR so a relocated file is still caught.
		claudeJsonPath(home),
		// The per-repo One Code settings file also carries permission rules. The
		// tail regex catches it under a literal `.onecode`; this catches it when
		// ONECODE_STATE_DIR relocated the state root (review L2).
		...(oneCodeProjectSettings ? [oneCodeProjectSettings] : []),
	];
}

/**
 * Whether a *resolved* path (resolveForContainment output) is a gate control.
 * `oneCodeProjectSettings` is the current repo's One Code settings file, resolved
 * by the caller (once per session) so this need not re-walk for the project root.
 */
export function isSafetyControlTarget(resolved: string, home: string, oneCodeProjectSettings?: string): boolean {
	const target = fold(resolved);
	if (SETTINGS_TAIL.test(target) || ONECODE_SETTINGS_TAIL.test(target)) return true;
	// The control files go through the same resolution as the write target, or
	// the two sides can disagree about the same file (macOS /var → /private/var).
	return safetyControlFiles(home, oneCodeProjectSettings).some((file) => {
		const control = resolveForContainment(file) ?? fold(file);
		return control === target || fold(file) === target;
	});
}

export interface FloorInput {
	/** Already-normalized tool name (see permissions/matcher.ts). */
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	home: string;
	/**
	 * The current repo's One Code settings file, resolved once per session by the
	 * caller. When omitted it is derived from `cwd` (a filesystem walk) — fine for
	 * tests, but the per-tool-call permission path passes it to avoid the walk
	 * (distribution review 2026-09-09, L2 / efficiency pass).
	 */
	oneCodeProjectSettings?: string;
}

const REASON = (token: string) =>
	`it writes ${token}, which holds the permission rules and auto-mode configuration that contain this agent`;

/**
 * Reason text when this call writes a safety-control file, undefined otherwise.
 * Paths are resolved through symlinks (dangling leaves and not-yet-existing
 * files included), so linking a settings file elsewhere and writing the link
 * does not slip past.
 */
export function safetyControlWrite({ toolName, input, cwd, home, oneCodeProjectSettings }: FloorInput): string | undefined {
	const perRepoSettings = oneCodeProjectSettings ?? oneCodeProjectSettingsPath(cwd, home);

	if (isWritingTool(toolName)) {
		const raw = input.path ?? input.file_path ?? input.notebook_path;
		if (typeof raw !== "string" || raw.length === 0) return undefined;
		const resolved = resolveForContainment(toAbsolute(cwd, raw, home));
		return resolved && isSafetyControlTarget(resolved, home, perRepoSettings) ? REASON(raw) : undefined;
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;
		const evidence = analyzeShellCommand({ command, cwd, home });
		for (const write of evidence.writes) {
			if (write.resolved && isSafetyControlTarget(write.resolved, home, perRepoSettings)) return REASON(write.token);
		}
	}

	if (toolName === "powershell") {
		// No PowerShell write model yet, so the floor is textual and wider than
		// bash's: ANY mention of a gate-control file in the command line stops it,
		// whether the cmdlet reads or writes. A `Get-Content` of settings.json
		// costs one prompt; a `Set-Content` that slipped through would cost the
		// gate (the floor may only ever say "stop" — header).
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;
		for (const token of powershellPathTokens(command, home)) {
			const resolved = resolveForContainment(toAbsolute(cwd, token, home)) ?? toAbsolute(cwd, token, home);
			if (isSafetyControlTarget(resolved, home, perRepoSettings)) return REASON(token);
		}
	}

	return undefined;
}

/**
 * Path-looking tokens of a PowerShell line, quotes stripped, `$env:USERPROFILE`,
 * `$env:HOME`, `$HOME` and `~` expanded to the home dir, backslashes
 * forward-slashed. Anything with a separator or a `.json`-style file name
 * counts; the floor tolerates false positives.
 */
export function powershellPathTokens(command: string, home: string): string[] {
	const out: string[] = [];
	for (const raw of command.split(/[\s;|()]+/)) {
		let token = raw.replace(/^["']+|["',]+$/g, "");
		if (!token) continue;
		token = token
			.replace(/^\$env:(USERPROFILE|HOME)/i, home)
			.replace(/^\$HOME\b/i, home)
			.replace(/^~(?=[\\/]|$)/, home)
			.replace(/\\/g, "/");
		// Parameter names (`-Path`) are not paths; `-Path:value` carries one.
		if (token.startsWith("-")) {
			const colon = token.indexOf(":");
			if (colon === -1) continue;
			token = token.slice(colon + 1);
		}
		if (/[\\/]/.test(token) || /\.json$/i.test(token)) out.push(token);
	}
	return out;
}
