/**
 * The configured default subagent model (pure fs).
 *
 * Two knobs, the environment's first:
 *
 * - The `SUBAGENT_MODEL` knob (lib/profile/knobs.ts): the product's
 *   `<envPrefix>_SUBAGENT_MODEL`, or Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL`
 *   while its sources are on. Honored from the real
 *   environment, and from the `env` block of *user and managed* settings files
 *   (Claude Code applies settings `env` to the process; One Code does not, so this
 *   reads the one variable it needs). Project-scope settings are deliberately
 *   not read: both project files live in the repository, and a checked-in `env`
 *   block must not get to pick which provider receives subagent tasks — the
 *   same containment rule as `autoMode` config.
 * - `subagentModel` — One Code's own top-level setting. Wins over the env var when both are set,
 *   because it is the more specific statement of intent. It is One Code's key,
 *   not Claude Code's: it is written to and read from `~/.onecode/settings.json`
 *   (+ managed settings), never from `~/.claude`, where an old One Code build may
 *   have left a stale value the current session cannot reach. Claude Code's own
 *   `CLAUDE_CODE_SUBAGENT_MODEL` env block is still honoured from `~/.claude`
 *   (that key *is* Claude Code's). See "Own state, borrowed config" in
 *   working-docs/decisions/memory-state.md.
 *
 * Another tool's spelling applies only where the source provider says (see
 * `applicableSubagentDefault`); the product's own spelling applies on any
 * model. On any other provider
 * it is ignored; One Code's automatic same-provider role profile then chooses the
 * default unless the user overrides it with `subagentModel`.
 *
 * The value is a spec, not a model: "sonnet", "inherit", or "provider/id" all
 * pass through to resolveSubagentModel, which owns the semantics.
 */

import { type Knob, knobAppliesTo, readKnob } from "../profile/knobs.ts";
import { isBorrowedUserFile, readSettingsFile } from "../profile/claude-settings.ts";
import { productSettingsPath, readSettingsForWrite, writeSettings } from "../profile/product-settings.ts";
import { autoModeSettingsFiles } from "../rules/auto-mode-config.ts";

/** The environment knob for the subagent default (lib/profile/knobs.ts). */
export const SUBAGENT_MODEL_KNOB = "SUBAGENT_MODEL";

/** The configured default, from the `subagentModel` setting or the `SUBAGENT_MODEL` environment knob (lib/profile/knobs.ts). */
export type SubagentDefault = SubagentSettingDefault | SubagentEnvDefault;

export interface SubagentEnvDefault {
	spec: string;
	source: "env";
	/** The variable that set it, in the process or a settings `env` block, for notices. */
	envVar: string;
	/** Set through another tool's spelling (the provider's alias), so it applies where the provider says (lib/profile/knobs.ts `knobAppliesTo`). */
	borrowed: boolean;
}

export interface SubagentSettingDefault {
	spec: string;
	source: "subagentModel setting";
	/**
	 * The *containment identity* of the
	 * session it was stamped for when set via `/subagent` — `modelIdentity().containment`,
	 * i.e. the plain provider for direct vendors but `provider:route:vendor` on a
	 * gateway (openrouter etc.), matching the granularity `crossesProvider` uses.
	 * When it differs from the current session's containment, a cross-provider
	 * setting is treated as stale (set for a session since left) and a
	 * same-provider model runs instead — see `resolveSubagentModel`. Undefined for
	 * a hand-edited setting (no stamp).
	 */
	setForContainment?: string;
}

interface SettingsFile {
	subagentModel?: unknown;
	subagentModelSetFor?: unknown;
	env?: Record<string, unknown>;
}

/** The shared lenient reader, narrowed to the subagent-relevant shape. */
function readSettings(path: string): SettingsFile | undefined {
	return readSettingsFile(path) as SettingsFile | undefined;
}

export function loadSubagentDefault(home: string, env: NodeJS.ProcessEnv = process.env): SubagentDefault | undefined {
	let setting: string | undefined;
	let settingSetFor: string | undefined;
	let settingsEnv: Knob | undefined;

	// `subagentModel` is One Code's own key — read from `~/.onecode` and managed
	// settings, never from `~/.claude`, where an old build may have left a stale
	// value. Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL` env block IS Claude Code's,
	// so it is still read from every file.
	// Lowest precedence first, so managed settings override user settings.
	for (const source of autoModeSettingsFiles(home)) {
		const file = readSettings(source.path);
		if (!file) continue;
		if (!isBorrowedUserFile(source) && typeof file.subagentModel === "string" && file.subagentModel.trim()) {
			setting = file.subagentModel.trim();
			// The stamp travels with the model from the same file (a lower-precedence
			// stamp must not attach to a higher-precedence model).
			settingSetFor =
				typeof file.subagentModelSetFor === "string" && file.subagentModelSetFor.trim()
					? file.subagentModelSetFor.trim()
					: undefined;
		}
		const fromEnvBlock = file.env ? readKnob(SUBAGENT_MODEL_KNOB, file.env) : undefined;
		if (fromEnvBlock?.value.trim()) settingsEnv = fromEnvBlock;
	}

	if (setting) return { spec: setting, source: "subagentModel setting", setForContainment: settingSetFor };

	const fromEnv = readKnob(SUBAGENT_MODEL_KNOB, env);
	const knob = fromEnv?.value.trim() ? fromEnv : settingsEnv;
	if (knob) return { spec: knob.value.trim(), source: "env", envVar: knob.name, borrowed: knob.borrowed };

	return undefined;
}

/**
 * The configured default that actually applies to this session.
 *
 * `subagentModel` is the product's own setting — the user told *this* harness
 * what subagents run on, so it applies on any provider, and so does the
 * product's own spelling of the knob. Another tool's spelling applies where
 * the source provider says (lib/profile/knobs.ts `knobAppliesTo`; One Code's: Claude
 * Code's only on a Claude model).
 */
export function applicableSubagentDefault(
	configured: SubagentDefault | undefined,
	sessionModel: { provider: string; id: string } | undefined,
): SubagentDefault | undefined {
	if (configured?.source !== "env" || !sessionModel) return configured;
	return knobAppliesTo(SUBAGENT_MODEL_KNOB, configured, sessionModel) ? configured : undefined;
}

/**
 * Persist `subagentModel` in One Code's own settings file
 * (`~/.onecode/settings.json`), preserving every other key. `undefined` removes
 * the setting. Never touches Claude Code's files: this is One Code's key, and the
 * default may move subagent work to another provider, so it lives in One Code's
 * own state (see the module comment).
 *
 * Unlike loading, this throws on a malformed file: a lenient read merely
 * skips a setting, but a lenient write would replace the whole settings file
 * with only ours.
 *
 * `setForContainment` stamps the containment identity of the session the model
 * was chosen on (modelIdentity().containment), so a later session on a different
 * provider/vendor can treat the setting as stale. Pass it for a concrete model;
 * it is cleared for `inherit` (never cross-provider) and on removal.
 */
export function persistSubagentModel(spec: string | undefined, home: string, setForContainment?: string): void {
	const path = productSettingsPath(home);
	const file = readSettingsForWrite(path);
	if (spec === undefined) {
		delete file.subagentModel;
		delete file.subagentModelSetFor;
	} else {
		file.subagentModel = spec;
		if (setForContainment && spec !== "inherit") file.subagentModelSetFor = setForContainment;
		else delete file.subagentModelSetFor;
	}
	writeSettings(path, file);
}
