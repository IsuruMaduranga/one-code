/**
 * Claude Code settings.json permissions loading/merging/persistence (pure fs).
 *
 * Sources, lowest to highest precedence:
 *   ~/.claude/settings.json               (user, borrowed — read only)
 *   ~/.onecode/settings.json             (One Code global — read + write)
 *   <cwd>/.claude/settings.json           (project, checked in — read only)
 *   <cwd>/.claude/settings.local.json     (project, personal — read only)
 *   ~/.onecode/projects/<slug>/settings.json (One Code per repo — read + write)
 *   <managed-settings.json>                (organisation policy — read only, highest)
 *
 * allow/deny/ask arrays concatenate across sources — except that the two
 * in-repo files' allow rules land in `projectAllow`, gated behind consent
 * (review P10); defaultMode from the most specific `.claude` source wins, with
 * managed settings above all (the One Code files contribute rules only).
 * One Code persists the rules it records to its own files, never into Claude
 * Code's — `persistAllowRule` is pointed at a One Code path by its caller.
 * Unknown keys in the files are preserved on write.
 */

import { managedSettingsPaths } from "../auto-mode/config.ts";
import { readSettingsFile as readClaudeSettingsFile, settingsPaths } from "../lib/claude-settings.ts";
import {
	oneCodeProjectSettingsPath,
	oneCodeSettingsPath,
	readSettingsForWrite,
	writeSettings,
} from "../lib/one-code-settings.ts";
import type { PermissionMode } from "./matcher.ts";

export { settingsPaths };

export interface PermissionSettings {
	/** Allow rules from sources the user wrote or that outrank the repo (user, One Code, managed). */
	allow: string[];
	/**
	 * Allow rules from the repository's own `.claude/settings.json` /
	 * `settings.local.json`. A checked-in file pre-approving `Bash(curl:*)` is a
	 * grant the user never made, so these apply only after a once-per-config
	 * consent (project-trust.ts) — deny and ask rules from the same files load
	 * freely, since they can only tighten the gate.
	 */
	projectAllow: string[];
	deny: string[];
	ask: string[];
	defaultMode?: PermissionMode;
	/**
	 * Claude Code's `permissions.disableBypassPermissionsMode: "disable"` seen in
	 * any source: bypassPermissions is refused however it is requested (flag,
	 * `--dangerously-skip-permissions`, settings). A restriction, so every scope
	 * may set it — the repo included.
	 */
	disableBypassPermissionsMode?: boolean;
}

interface ClaudeSettingsFile {
	permissions?: {
		allow?: string[];
		deny?: string[];
		ask?: string[];
		defaultMode?: string;
		disableBypassPermissionsMode?: string;
	};
	[key: string]: unknown;
}

/**
 * Modes a repository's own files (`<cwd>/.claude/settings.json`,
 * `settings.local.json`) may NOT select — honoured from user and managed scope
 * only. Both files live in the checkout, so honouring these there lets a cloned
 * repo grant itself the mode: `auto`, whose classifier is what contains it
 * (Claude Code makes the same exclusion), and `bypassPermissions`, which has no
 * classifier, no prompt and no protected path at all — the footer badge is the
 * only sign (PERMISSIONS-REVIEW-2026-09-05 H3, measured: a checked-in
 * `bypassPermissions` ran an outside-project write with no prompt). `dontAsk`
 * and `acceptEdits` stay honoured: neither can approve what default mode would
 * not (dontAsk turns asks into denials; acceptEdits is confined to the working
 * directory).
 */
export const MODES_NEVER_FROM_PROJECT: ReadonlySet<PermissionMode> = new Set<PermissionMode>(["auto", "bypassPermissions"]);

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

/** Display-name aliases Claude Code accepts wherever a mode is named. */
const MODE_ALIASES: Record<string, PermissionMode> = { manual: "default" };

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (MODES as string[]).includes(value);
}

/** A mode value from user input (flag, settings, env), aliases included. */
export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
	if (isPermissionMode(value)) return value;
	return typeof value === "string" ? MODE_ALIASES[value] : undefined;
}

function readSettingsFile(path: string): ClaudeSettingsFile | undefined {
	// Shared reader (lib/claude-settings.ts) — this module narrows to the
	// permissions-relevant shape.
	return readClaudeSettingsFile(path) as ClaudeSettingsFile | undefined;
}

export function loadPermissionSettings(cwd: string, home: string): PermissionSettings {
	const paths = settingsPaths(cwd, home);
	const merged: PermissionSettings = { allow: [], projectAllow: [], deny: [], ask: [] };

	// One Code writes the rules it records (via /allow, the auto-mode setup) to its
	// own files, never into Claude Code's — so its own files are read alongside the
	// borrowed `.claude` ladder. They contribute allow/deny/ask rules only;
	// `defaultMode` stays sourced from the `.claude` files (nothing here writes it,
	// and keeping the auto-mode reasoning to one place avoids a second `auto` path).
	const oneCodeGlobal = oneCodeSettingsPath(home);
	const oneCodeProject = oneCodeProjectSettingsPath(cwd, home);

	// Managed settings last: Claude Code's organisation policy outranks every
	// user/project file, for rules and for defaultMode alike (review P14).
	const managed = managedSettingsPaths();
	for (const path of [paths.user, oneCodeGlobal, paths.project, paths.local, oneCodeProject, ...managed]) {
		const file = readSettingsFile(path);
		const perms = file?.permissions;
		if (!perms) continue;
		const allowTarget = path === paths.project || path === paths.local ? merged.projectAllow : merged.allow;
		if (Array.isArray(perms.allow)) allowTarget.push(...perms.allow.filter((r) => typeof r === "string"));
		if (Array.isArray(perms.deny)) merged.deny.push(...perms.deny.filter((r) => typeof r === "string"));
		if (Array.isArray(perms.ask)) merged.ask.push(...perms.ask.filter((r) => typeof r === "string"));
		if (perms.disableBypassPermissionsMode === "disable") merged.disableBypassPermissionsMode = true;
		if (path === oneCodeGlobal || path === oneCodeProject) continue;
		const defaultMode = normalizePermissionMode(perms.defaultMode);
		// The modes a repo may not grant itself (MODES_NEVER_FROM_PROJECT) are
		// honoured from user and managed scope only.
		const fromProject = path === paths.project || path === paths.local;
		if (defaultMode && !(fromProject && MODES_NEVER_FROM_PROJECT.has(defaultMode))) {
			merged.defaultMode = defaultMode;
		}
	}

	return merged;
}

/**
 * The mode a session starts in, from the modes requested in Claude Code's
 * precedence order (`--dangerously-skip-permissions`, `--permission-mode`,
 * settings' `defaultMode`), skipping `bypassPermissions` wherever a settings
 * source disabled it (CC's `permissionSetup.ts`). `mode` is undefined when
 * nothing usable was requested — the caller keeps its live mode, so a
 * mid-session reload never undoes a ctrl+q switch. `bypassRefused` says a
 * bypass request was skipped, for CC's "disabled by settings" notification.
 */
export function resolveStartupMode(
	requested: (PermissionMode | undefined)[],
	settings: Pick<PermissionSettings, "disableBypassPermissionsMode">,
): { mode?: PermissionMode; bypassRefused: boolean } {
	let bypassRefused = false;
	for (const candidate of requested) {
		if (!candidate) continue;
		if (candidate === "bypassPermissions" && settings.disableBypassPermissionsMode) {
			bypassRefused = true;
			continue;
		}
		return { mode: candidate, bypassRefused };
	}
	return { bypassRefused };
}

/**
 * Append an allow rule to a One Code settings file, creating it if needed.
 * Strict read + atomic write, like the other `~/.onecode` writers: a malformed
 * file is not silently clobbered (it may also hold classifierModel/subagentModel),
 * and a half-written file is never visible to a concurrent reader.
 */
export function persistAllowRule(rule: string, filePath: string): void {
	const file = readSettingsForWrite(filePath) as ClaudeSettingsFile;
	const permissions = (file.permissions ??= {});
	const allow = (permissions.allow ??= []);
	if (!allow.includes(rule)) allow.push(rule);
	writeSettings(filePath, file as Record<string, unknown>);
}
