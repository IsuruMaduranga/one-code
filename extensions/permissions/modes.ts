/**
 * Permission-mode cycling and display (pure).
 *
 * Mirrors Claude Code v2.1: the cycle is manual (`default`) → acceptEdits →
 * plan → [bypassPermissions] → [auto]. bypassPermissions joins only when the
 * session was started with it enabled; `auto` joins when a classifier model is
 * reachable, mirroring how Claude Code drops auto from the cycle where its
 * requirements aren't met. `dontAsk` never appears in the cycle in Claude Code
 * either — it is reachable only via flag or settings.
 */

import type { PermissionMode } from "./matcher.ts";

/** Footer badge per mode — Claude Code's exact strings and icons. */
export const MODE_BADGES: Record<PermissionMode, string> = {
	default: "⏸ manual mode on",
	acceptEdits: "⏵⏵ accept edits on",
	plan: "⏸ plan mode on",
	bypassPermissions: "⏵⏵ bypass permissions on",
	dontAsk: "⏵⏵ don't ask on",
	auto: "⏵⏵ auto mode on",
};

const CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan"];

export interface CycleOptions {
	bypassInCycle: boolean;
	autoInCycle: boolean;
}

/**
 * Shorten a model id for the footer, which has little room. Drops an OpenRouter
 * style `vendor/` prefix and a trailing date stamp, both of which are noise once
 * the family name is visible: `anthropic/claude-haiku-4-5-20251001` → `haiku-4-5`.
 */
export function shortModelName(id: string): string {
	const afterSlash = id.slice(id.lastIndexOf("/") + 1);
	const undated = afterSlash.replace(/-20\d{6}$/, "");
	return undated.replace(/^(claude|gpt|gemini|llama|grok|mistral|deepseek|qwen)-/, "");
}

/**
 * The key that cycles permission modes. Claude Code cycles on shift+tab and
 * says so in this footer; pi reserves shift+tab for the effort dial, so One Code
 * cycles on ctrl+q (see docs/decisions/modes.md) and the hint names that key.
 */
export const CYCLE_KEY_HINT = "ctrl+q to cycle";

/**
 * The footer badge, with auto mode naming the model screening the calls. That
 * model reads the user's prompts and their CLAUDE.md, so which one it is belongs
 * on screen rather than buried in a command — and before the first call settles
 * it, saying nothing is more honest than guessing. Ends with the cycle-key hint,
 * the way Claude Code's footer does, so the shortcut sits next to the state it
 * changes.
 */
export function modeBadge(
	mode: PermissionMode,
	opts?: { paused?: boolean; classifierModel?: string; streaming?: boolean },
): string {
	const base = badgeBase(mode, opts);
	// Claude Code appends the interrupt hint to this line while the model works.
	return `${base} (${CYCLE_KEY_HINT})${opts?.streaming ? " · esc to interrupt" : ""}`;
}

function badgeBase(mode: PermissionMode, opts?: { paused?: boolean; classifierModel?: string }): string {
	if (mode !== "auto") return MODE_BADGES[mode];
	const suffix = opts?.classifierModel ? ` · ${shortModelName(opts.classifierModel)}` : "";
	return opts?.paused ? `⏸ auto mode paused${suffix}` : `${MODE_BADGES.auto}${suffix}`;
}

/**
 * Cross-extension channel carrying the current mode and classifier, so the
 * startup banner can show them live. jiti gives each extension its own module
 * instance, so this goes over `pi.events` rather than shared state.
 */
export const PERMISSION_STATUS_CHANNEL = "one-code:permission-status";

export interface PermissionStatus {
	mode: string;
	paused: boolean;
	/** `provider/id` of the classifier screening calls (or about to). */
	classifier?: string;
	/** Whether `classifier` is pinned by a real call, or still the planned first candidate. */
	pinned?: boolean;
}

/**
 * The banner's mode line. In auto mode it names the classifier — that model
 * reads the user's prompts and CLAUDE.md, so which one it is belongs on screen
 * — and says when the name is still the plan rather than the settled fact.
 */
export function permissionModeDisplay(status: PermissionStatus): string {
	if (status.mode !== "auto") return status.mode;
	const name = status.classifier ? shortModelName(status.classifier) : "no model available";
	if (status.paused) return `auto (paused) · classifier ${name}`;
	return `auto · classifier ${name}${status.pinned ? "" : " (planned)"}`;
}

/**
 * The mode the cycle shortcut lands on next. A mode outside the cycle
 * (dontAsk, or bypass in a session that didn't start with it) exits to the
 * cycle's start rather than being unreachable-from.
 */
export function nextMode(current: PermissionMode, opts: CycleOptions): PermissionMode {
	const cycle: PermissionMode[] = [...CYCLE];
	if (opts.bypassInCycle) cycle.push("bypassPermissions");
	if (opts.autoInCycle) cycle.push("auto");
	const index = cycle.indexOf(current);
	return cycle[(index + 1) % cycle.length];
}
