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
import { resolve } from "node:path";
import { expandTilde } from "../lib/paths.ts";
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
		additionalDirectories?: string[];
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

export type RuleBehavior = "allow" | "ask" | "deny";

/** Where a permission rule was read from, for the `/permissions` panel. */
export type RuleSource = "claude-user" | "onecode-user" | "project" | "project-local" | "onecode-project" | "managed";

export interface SourcedRule {
	behavior: RuleBehavior;
	raw: string;
	source: RuleSource;
	/** The settings file the rule is in. */
	path: string;
}

/** Every settings file permissions are read from, lowest precedence first, with its source. */
function permissionSources(cwd: string, home: string): Array<[RuleSource, string]> {
	const paths = settingsPaths(cwd, home);
	return [
		["claude-user", paths.user],
		["onecode-user", oneCodeSettingsPath(home)],
		["project", paths.project],
		["project-local", paths.local],
		["onecode-project", oneCodeProjectSettingsPath(cwd, home)],
		...managedSettingsPaths().map((path): [RuleSource, string] => ["managed", path]),
	];
}

export interface SourcedDirectory {
	/** As written in the settings file. */
	raw: string;
	/** Absolute: `~` expanded, a relative entry resolved against the working directory. */
	path: string;
	source: RuleSource;
	/** The settings file it is in. */
	settingsPath: string;
}

/**
 * Claude Code's `permissions.additionalDirectories`, from every source, with
 * the file each came from. The caller decides which sources are trusted: a
 * repository's own files are applied only after the user trusts them.
 */
export function listWorkspaceDirectories(cwd: string, home: string): SourcedDirectory[] {
	const dirs: SourcedDirectory[] = [];
	for (const [source, settingsPath] of permissionSources(cwd, home)) {
		const list = readSettingsFile(settingsPath)?.permissions?.additionalDirectories;
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			if (typeof raw !== "string" || !raw.trim()) continue;
			dirs.push({ raw, path: resolve(cwd, expandTilde(raw.trim(), home)), source, settingsPath });
		}
	}
	return dirs;
}

/** Add a directory to a One Code settings file's `permissions.additionalDirectories`. */
export function persistWorkspaceDirectory(dir: string, filePath: string): void {
	addToPermissionsList("additionalDirectories", dir, filePath);
}

/** Remove a directory, as written, from a One Code settings file. False when it is not there. */
export function removeWorkspaceDirectory(raw: string, filePath: string): boolean {
	return removeFromPermissionsList("additionalDirectories", raw, filePath);
}

/**
 * Every permission rule with the file it came from, in load order (the order
 * `loadPermissionSettings` merges them). The panel lists them and can delete a
 * rule from One Code's own files only: One Code never edits Claude Code's
 * files, the repository's or managed policy.
 */
export function listPermissionRules(cwd: string, home: string): SourcedRule[] {
	const rules: SourcedRule[] = [];
	for (const [source, path] of permissionSources(cwd, home)) {
		const perms = readSettingsFile(path)?.permissions;
		if (!perms) continue;
		for (const behavior of ["allow", "ask", "deny"] as const) {
			const list = perms[behavior];
			if (!Array.isArray(list)) continue;
			for (const raw of list) if (typeof raw === "string") rules.push({ behavior, raw, source, path });
		}
	}
	return rules;
}

/**
 * Append a rule to a One Code settings file, creating it if needed.
 * Strict read + atomic write, like the other `~/.onecode` writers: a malformed
 * file is not silently clobbered (it may also hold classifierModel/subagentModel),
 * and a half-written file is never visible to a concurrent reader. Returns
 * false, writing nothing, when the file already holds the rule.
 */
export function persistPermissionRule(behavior: RuleBehavior, rule: string, filePath: string): boolean {
	return addToPermissionsList(behavior, rule, filePath);
}

/** `persistPermissionRule` for an allow rule (`/allow`). */
export function persistAllowRule(rule: string, filePath: string): void {
	persistPermissionRule("allow", rule, filePath);
}

/**
 * Remove every copy of a rule from a One Code settings file. Returns false,
 * writing nothing, when the file does not hold it. An emptied list is kept as
 * `[]`, and the file's other keys are preserved.
 */
export function removePermissionRule(behavior: RuleBehavior, rule: string, filePath: string): boolean {
	return removeFromPermissionsList(behavior, rule, filePath);
}

/** A string list under `permissions` that One Code edits in its own files. */
type PermissionsList = RuleBehavior | "additionalDirectories";

/** False, writing nothing, when the list already holds `value`. */
function addToPermissionsList(field: PermissionsList, value: string, filePath: string): boolean {
	const file = readSettingsForWrite(filePath) as ClaudeSettingsFile;
	const list = ((file.permissions ??= {})[field] ??= []);
	if (list.includes(value)) return false;
	list.push(value);
	writeSettings(filePath, file as Record<string, unknown>);
	return true;
}

function removeFromPermissionsList(field: PermissionsList, value: string, filePath: string): boolean {
	const file = readSettingsForWrite(filePath) as ClaudeSettingsFile;
	const list = file.permissions?.[field];
	if (!Array.isArray(list) || !list.includes(value)) return false;
	file.permissions![field] = list.filter((entry) => entry !== value);
	writeSettings(filePath, file as Record<string, unknown>);
	return true;
}
