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

import { join } from "node:path";
import { analyzeShellCommand } from "./shell-analysis.ts";
import { autoModeSettingsPaths } from "./config.ts";
import { resolveForContainment, toAbsolute } from "./paths.ts";

const WRITING_TOOLS = new Set(["edit", "write", "notebook_edit"]);

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

function safetyControlFiles(home: string): string[] {
	return [
		// autoMode + user permission rules, and the managed-settings paths.
		...autoModeSettingsPaths(home),
		// Claude Code's global state file also carries permission configuration.
		join(home, ".claude.json"),
	];
}

/** Whether a *resolved* path (resolveForContainment output) is a gate control. */
export function isSafetyControlTarget(resolved: string, home: string): boolean {
	const target = fold(resolved);
	if (SETTINGS_TAIL.test(target)) return true;
	// The control files go through the same resolution as the write target, or
	// the two sides can disagree about the same file (macOS /var → /private/var).
	return safetyControlFiles(home).some((file) => {
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
}

const REASON = (token: string) =>
	`it writes ${token}, which holds the permission rules and auto-mode configuration that contain this agent`;

/**
 * Reason text when this call writes a safety-control file, undefined otherwise.
 * Paths are resolved through symlinks (dangling leaves and not-yet-existing
 * files included), so linking a settings file elsewhere and writing the link
 * does not slip past.
 */
export function safetyControlWrite({ toolName, input, cwd, home }: FloorInput): string | undefined {
	if (WRITING_TOOLS.has(toolName)) {
		const raw = input.path ?? input.file_path ?? input.notebook_path;
		if (typeof raw !== "string" || raw.length === 0) return undefined;
		const resolved = resolveForContainment(toAbsolute(cwd, raw, home));
		return resolved && isSafetyControlTarget(resolved, home) ? REASON(raw) : undefined;
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;
		const evidence = analyzeShellCommand({ command, cwd, home });
		for (const write of evidence.writes) {
			if (write.resolved && isSafetyControlTarget(write.resolved, home)) return REASON(write.token);
		}
	}

	return undefined;
}
