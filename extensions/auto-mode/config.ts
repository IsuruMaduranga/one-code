/**
 * `autoMode` settings loading (pure fs), Claude Code compatible.
 *
 * ## Which files are read, and why that list is short
 *
 * User settings (`~/.claude/settings.json`), One Code's own user settings
 * (`~/.onecode/settings.json`), and managed settings only — **never the
 * project's `.claude/settings.json` or `.claude/settings.local.json`**. Both
 * project files live in the repository, so a checked-in file or a build step
 * that writes one could otherwise hand itself classifier permissions and switch
 * off the gate that is meant to contain it. Claude Code made the same exclusion
 * (it dropped `settings.local.json` in v2.1.207); this is that property, not an
 * omission.
 *
 * ## Read vs. write: `.claude` is borrowed, `~/.onecode` is ours
 *
 * The CC-schema keys (`environment`, `hard_deny`/`soft_deny`/`allow`) are read
 * from `~/.claude` too, because Claude Code's own `/auto-mode-setup` writes them
 * there and reading them is the compatibility promise. But One Code's *own*
 * keys — `classifierModel` / `classifierModelSetFor`, which Claude Code does not
 * define — are read from `~/.onecode` and managed settings only, never from
 * `~/.claude`: One Code used to write them there, and a stale value (a model the
 * session cannot reach) must not keep biting. Every write goes to
 * `~/.onecode/settings.json`; One Code never mutates Claude Code's files. See
 * "Own state, borrowed config" in docs/decisions/memory-state.md.
 *
 * ## The customization surface (CC 2.1.233's own)
 *
 * The ruleset is CC's fixed monolith (classifier-prompt.ts); its prose is not
 * user-editable, by design — the ruleset *is* the security boundary. What CC's
 * `/auto-mode-setup` exposes (and we mirror exactly) is:
 *
 * - `environment` — replaces the `## Environment` slot lines. `"$defaults"`
 *   splices CC's default slots at that position, so a user can extend rather
 *   than replace.
 * - `hard_deny` / `soft_deny` / `allow` — extra rules **appended** to the end of
 *   the matching embedded list, verbatim, exactly where CC injects them. These
 *   are append-only: `"$defaults"` is accepted (CC's wizard always writes it)
 *   but carries no meaning — the built-in rules always apply and cannot be
 *   removed or reordered from settings, so an extra rule can tighten or carve
 *   out, never rewrite the boundary.
 *
 * (The rule lists were briefly retired between the ruleset adoption and CC
 * 2.1.233 shipping `/auto-mode-setup`, which writes this exact schema — see
 * docs/decisions/auto-mode.md.)
 */

import { existsSync, readFileSync } from "node:fs";
import { claudeUserSettingsPath } from "../lib/claude-settings.ts";
import { oneCodeSettingsPath, readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";
import { DEFAULT_ENVIRONMENT, slotName } from "./defaults.ts";

export interface AutoModeConfig {
	/** Environment slot lines spliced into CC's ruleset (prefix-less, CC's settings format). */
	environment: string[];
	/** Extra HARD BLOCK rules appended to the embedded list (`$defaults` already stripped). */
	hardDeny: string[];
	/** Extra SOFT BLOCK rules appended to the embedded list (`$defaults` already stripped). */
	softDeny: string[];
	/** Extra ALLOW rules appended to the embedded list (`$defaults` already stripped). */
	allow: string[];
	/** Suspend narrow Bash allow rules so every shell command reaches the classifier. */
	classifyAllShell: boolean;
	/** `provider/model-id` override for the classifier model. */
	classifierModel?: string;
	/**
	 * Containment identity (`modelIdentity().containment`) the `classifierModel`
	 * was stamped for when set via `/auto-mode model`. A cross-provider setting
	 * whose stamp no longer matches the session is treated as stale and overridden
	 * — see `classifierCandidates`. Undefined for a hand-edited setting.
	 */
	classifierModelSetFor?: string;
	/** Append every gate decision to auto-mode-decisions.jsonl next to the session files. */
	logDecisions: boolean;
}

interface AutoModeSettingsFile {
	autoMode?: {
		environment?: unknown;
		hard_deny?: unknown;
		soft_deny?: unknown;
		allow?: unknown;
		classifyAllShell?: unknown;
		classifierModel?: unknown;
		classifierModelSetFor?: unknown;
		logDecisions?: unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

const DEFAULTS_TOKEN = "$defaults";

/** Managed-settings locations, highest authority, matching Claude Code's paths. */
function managedSettingsPaths(): string[] {
	if (process.platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
	if (process.platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
	return ["/etc/claude-code/managed-settings.json"];
}

/**
 * The files `autoMode` is read from, lowest precedence first. One Code's own
 * auto-mode keys (`classifierModel`, `classifierModelSetFor`) are deliberately
 * NOT collected from the borrowed `claudeUserSettingsPath` — Claude Code does not
 * define them, and One Code once wrote them there, so a stale value must not
 * survive the move to `~/.onecode` (see the read guard in the loader).
 */
export function autoModeSettingsPaths(home: string): string[] {
	return [claudeUserSettingsPath(home), oneCodeSettingsPath(home), ...managedSettingsPaths()];
}

function readFile(path: string, diagnostics: string[]): AutoModeSettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AutoModeSettingsFile;
	} catch (error) {
		// Swallowing this silently is how a user ends up believing rules are in
		// force that the gate never loaded — the file is still skipped (the gate
		// must not die on a typo), but the skip is reported.
		diagnostics.push(`${path}: invalid JSON, autoMode settings in it are ignored (${(error as Error).message})`);
		return undefined;
	}
}

const KNOWN_AUTO_MODE_KEYS = new Set([
	"environment",
	"hard_deny",
	"soft_deny",
	"allow",
	"classifyAllShell",
	"classifierModel",
	"classifierModelSetFor",
	"logDecisions",
]);

/** Rule-extra keys, CC's spelling; appended to the matching embedded list. */
const RULE_LIST_KEYS = ["hard_deny", "soft_deny", "allow"] as const;

/**
 * Shape problems in one file's `autoMode` block, as human-readable lines.
 * Purely advisory: loading stays lenient (a wrong-typed field is skipped, not
 * fatal), but skipped-because-mistyped must be visible in `/auto-mode config` or
 * it reads as the gate ignoring the user's settings.
 */
/**
 * Validate one array-of-strings autoMode key. `omitDefaultsNote`, when given,
 * is the warning pushed if "$defaults" is missing. Purely advisory: loading
 * stays lenient either way.
 */
function validateStringListKey(
	block: Record<string, unknown>,
	key: string,
	path: string,
	diagnostics: string[],
	omitDefaultsNote?: string,
): void {
	const list = block[key];
	if (list === undefined) return;
	if (!Array.isArray(list)) {
		diagnostics.push(`${path}: autoMode.${key} must be an array of strings — ignored`);
		return;
	}
	for (const [position, entry] of list.entries()) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			diagnostics.push(`${path}: autoMode.${key}[${position}] is not a non-empty string — dropped`);
		}
	}
	if (!omitDefaultsNote) return;
	const strings = list.filter((entry): entry is string => typeof entry === "string");
	if (strings.length > 0 && !strings.some((entry) => entry.trim() === DEFAULTS_TOKEN)) {
		diagnostics.push(`${path}: autoMode.${key} ${omitDefaultsNote}`);
	}
}

function validateAutoModeBlock(block: Record<string, unknown>, path: string, diagnostics: string[]): void {
	for (const key of Object.keys(block)) {
		if (!KNOWN_AUTO_MODE_KEYS.has(key)) {
			diagnostics.push(`${path}: unknown autoMode key "${key}" is ignored`);
		}
	}
	validateStringListKey(block, "environment", path, diagnostics);
	// A FULL environment replacement (every built-in slot re-stated, edited or
	// not) is the standard shape — CC's wizard and ours both write it — so it
	// earns no warning. What does: a replacement that silently DROPS built-in
	// slots because "$defaults" is absent — usually a hand-written list whose
	// author believed they were adding, not replacing.
	const environment = block.environment;
	if (Array.isArray(environment)) {
		const strings = environment.filter((entry): entry is string => typeof entry === "string");
		if (strings.length > 0 && !strings.some((entry) => entry.trim() === DEFAULTS_TOKEN)) {
			const present = new Set(strings.map(slotName).filter(Boolean));
			const missing = DEFAULT_ENVIRONMENT.map(slotName).filter((name): name is string => !!name && !present.has(name));
			if (missing.length > 0) {
				const shown = missing.slice(0, 3).join(", ") + (missing.length > 3 ? ", …" : "");
				diagnostics.push(
					`${path}: autoMode.environment omits "${DEFAULTS_TOKEN}", so it REPLACES the built-in environment rather than extending it — built-in slot(s) now missing: ${shown}`,
				);
			}
		}
	}
	// Unlike environment, the rule lists are append-only: the built-in rules
	// always apply whether or not "$defaults" is present (a settings file must be
	// able to add rules, never to remove the boundary), and nobody should believe
	// omitting the token disabled them.
	for (const key of RULE_LIST_KEYS) {
		validateStringListKey(
			block,
			key,
			path,
			diagnostics,
			`omits "${DEFAULTS_TOKEN}" — note the built-in rules still apply; these lists only append, never replace`,
		);
	}
	for (const key of ["classifyAllShell", "logDecisions"] as const) {
		if (block[key] !== undefined && typeof block[key] !== "boolean") {
			diagnostics.push(`${path}: autoMode.${key} must be a boolean — ignored`);
		}
	}
	if (
		block.classifierModel !== undefined &&
		(typeof block.classifierModel !== "string" || block.classifierModel.trim().length === 0)
	) {
		diagnostics.push(`${path}: autoMode.classifierModel must be a "provider/model-id" string — ignored`);
	}
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * Splice `$defaults` into a user list. Entries from separate scopes are additive:
 * a developer can extend a managed list but not remove from it.
 */
export function spliceDefaults(entries: string[] | undefined, defaults: string[]): string[] {
	if (!entries) return [...defaults];
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.trim() === DEFAULTS_TOKEN) out.push(...defaults);
		else out.push(entry);
	}
	return out;
}

export interface AutoModeConfigLoad {
	config: AutoModeConfig;
	/** Problems found while loading, for `/auto-mode config`. Empty when clean. */
	diagnostics: string[];
}

export function loadAutoModeConfigWithDiagnostics(home: string): AutoModeConfigLoad {
	const diagnostics: string[] = [];
	const collected: {
		environment?: string[];
		hard_deny?: string[];
		soft_deny?: string[];
		allow?: string[];
		classifyAllShell?: boolean;
		classifierModel?: string;
		classifierModelSetFor?: string;
		logDecisions?: boolean;
	} = {};

	const claudeUser = claudeUserSettingsPath(home);
	for (const path of autoModeSettingsPaths(home)) {
		const file = readFile(path, diagnostics);
		const block = file?.autoMode;
		if (file !== undefined && "autoMode" in file && (typeof block !== "object" || block === null || Array.isArray(block))) {
			diagnostics.push(`${path}: autoMode must be an object — ignored`);
			continue;
		}
		if (!block) continue;
		validateAutoModeBlock(block as Record<string, unknown>, path, diagnostics);
		// Additive across scopes: a later scope extends rather than replaces, so
		// managed entries cannot be dropped by a user file.
		const parsed = stringArray(block.environment);
		if (parsed) collected.environment = [...(collected.environment ?? []), ...parsed];
		for (const key of RULE_LIST_KEYS) {
			const list = stringArray(block[key]);
			if (list) collected[key] = [...(collected[key] ?? []), ...list];
		}
		if (typeof block.classifyAllShell === "boolean") collected.classifyAllShell = block.classifyAllShell;
		if (typeof block.logDecisions === "boolean") collected.logDecisions = block.logDecisions;
		// `classifierModel` is One Code's own key, not Claude Code's. It is read from
		// `~/.onecode` and managed settings only — never from `~/.claude`, where an
		// old One Code build may have left a stale value. A leftover in `~/.claude` is
		// surfaced as a diagnostic so the user knows why it stopped applying.
		if (typeof block.classifierModel === "string" && block.classifierModel.trim()) {
			if (path === claudeUser) {
				diagnostics.push(
					`${path}: autoMode.classifierModel is ignored here — One Code reads it from ~/.onecode/settings.json (set it with /auto-mode model)`,
				);
			} else {
				collected.classifierModel = block.classifierModel.trim();
				// The stamp travels with the model from the same file, so a lower-precedence
				// stamp cannot attach to a higher-precedence model.
				collected.classifierModelSetFor =
					typeof block.classifierModelSetFor === "string" && block.classifierModelSetFor.trim()
						? block.classifierModelSetFor.trim()
						: undefined;
			}
		}
	}

	// Rule lists are extras appended to the embedded built-ins, so "$defaults" is
	// stripped rather than expanded — the built-ins are already in the ruleset and
	// must apply regardless of what settings say (append-only, by construction).
	const ruleExtras = (entries: string[] | undefined): string[] =>
		(entries ?? []).filter((entry) => entry.trim() !== DEFAULTS_TOKEN);

	return {
		config: {
			environment: spliceDefaults(collected.environment, DEFAULT_ENVIRONMENT),
			hardDeny: ruleExtras(collected.hard_deny),
			softDeny: ruleExtras(collected.soft_deny),
			allow: ruleExtras(collected.allow),
			classifyAllShell: collected.classifyAllShell ?? false,
			classifierModel: collected.classifierModel,
			classifierModelSetFor: collected.classifierModelSetFor,
			logDecisions: collected.logDecisions ?? false,
		},
		diagnostics,
	};
}

export function loadAutoModeConfig(home: string): AutoModeConfig {
	return loadAutoModeConfigWithDiagnostics(home).config;
}

/**
 * Persist `autoMode.classifierModel` in One Code's own settings file
 * (`~/.onecode/settings.json`), preserving every other key. `undefined` removes
 * the setting. Never touches Claude Code's files — this is One Code's key, and
 * the knob that may move the classifier to another provider, so it lives in One
 * Code's own state (see the module comment).
 *
 * Unlike loading, this throws on a malformed file: a lenient read merely skips
 * rules, but a lenient write would replace the whole settings file with only ours.
 */
export function persistClassifierModel(spec: string | undefined, home: string, setForContainment?: string): void {
	const path = oneCodeSettingsPath(home);
	const file = readSettingsForWrite(path);
	const block = asRecord(file.autoMode) ?? {};
	if (spec === undefined) {
		delete block.classifierModel;
		delete block.classifierModelSetFor;
	} else {
		block.classifierModel = spec;
		// Stamp the containment the model was chosen on, so a later session on a
		// different provider treats a cross-provider setting as stale (parity with
		// subagentModelSetFor). No stamp for a hand-edited setting.
		if (setForContainment) block.classifierModelSetFor = setForContainment;
		else delete block.classifierModelSetFor;
	}
	if (Object.keys(block).length === 0) delete file.autoMode;
	else file.autoMode = block;
	writeSettings(path, file);
}

/** value as a plain object, or undefined — the repeated sub-block guard. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Persist a `/auto-mode setup` result to One Code's own settings file: replace
 * the wizard-owned keys (environment + the three rule lists — an undefined list
 * removes stale values, last-writer like CC's own wizard) while preserving every
 * other settings key and the non-wizard autoMode keys (classifierModel, …).
 * Never touches Claude Code's files; throws on a malformed file rather than
 * replacing the settings with only ours.
 */
export function persistAutoModeSetup(patch: Record<string, string[] | undefined>, home: string): void {
	const path = oneCodeSettingsPath(home);
	const file = readSettingsForWrite(path);
	const block = asRecord(file.autoMode) ?? {};
	for (const key of ["environment", ...RULE_LIST_KEYS] as const) {
		const value = patch[key];
		if (value === undefined) delete block[key];
		else block[key] = value;
	}
	if (Object.keys(block).length === 0) delete file.autoMode;
	else file.autoMode = block;
	writeSettings(path, file);
}

/**
 * The `permissions.allow` entries in One Code's own settings file — what the
 * setup audit can actually remove. Broad rules that live in Claude Code's files
 * are One Code's to warn about, never to delete.
 */
export function oneCodePermissionAllow(home: string): string[] {
	// Lenient read (a missing/malformed file is skipped) — this is a read for
	// auditing, not a write, so leniency is correct; the writers still refuse to
	// clobber a malformed file. Diagnostics are discarded here.
	return permissionAllowIn(oneCodeSettingsPath(home));
}

/**
 * The `permissions.allow` entries in Claude Code's *user* settings file — the
 * borrowed half of the audit. These are One Code's to warn about, never to
 * delete: an entry here still bypasses the classifier even after its One Code
 * copy is removed, so the audit must flag it separately.
 */
export function claudeUserPermissionAllow(home: string): string[] {
	return permissionAllowIn(claudeUserSettingsPath(home));
}

/** Shared lenient read of a settings file's `permissions.allow` string list. */
function permissionAllowIn(path: string): string[] {
	const list = asRecord(readFile(path, [])?.permissions)?.allow;
	return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Remove specific `permissions.allow` entries from One Code's own settings file
 * (the setup audit's "remove them" choice). Only One Code's own file is
 * touched — never Claude Code's. Exact-match only, everything else preserved;
 * throws on a malformed file for the same reason as the writers above. Returns
 * how many entries were actually removed.
 */
export function removeOneCodePermissionAllow(entries: string[], home: string): number {
	const path = oneCodeSettingsPath(home);
	const file = readSettingsForWrite(path);
	const permissions = asRecord(file.permissions);
	const allowList = permissions?.allow;
	if (!permissions || !Array.isArray(allowList)) return 0;
	const doomed = new Set(entries);
	const kept = allowList.filter((entry) => typeof entry !== "string" || !doomed.has(entry));
	const removed = allowList.length - kept.length;
	if (removed > 0) {
		permissions.allow = kept;
		writeSettings(path, file);
	}
	return removed;
}
