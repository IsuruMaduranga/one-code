/**
 * The configured default subagent model (pure fs).
 *
 * Two knobs, Claude Code's first:
 *
 * - `CLAUDE_CODE_SUBAGENT_MODEL` — Claude Code's env var. Honored from the real
 *   environment, and from the `env` block of *user and managed* settings files
 *   (Claude Code applies settings `env` to the process; One Code does not, so this
 *   reads the one variable it needs). Project-scope settings are deliberately
 *   not read: both project files live in the repository, and a checked-in `env`
 *   block must not get to pick which provider receives subagent tasks — the
 *   same containment rule as `autoMode` config.
 * - `subagentModel` — One Code's own top-level setting, same shape as
 *   `autoMode.classifierModel`. Wins over the env var when both are set,
 *   because it is the more specific statement of intent.
 *
 * The env var additionally applies only to Claude-family sessions (see
 * `applicableSubagentDefault`): it is Claude Code's knob, and its typical
 * values ("sonnet") were written for Anthropic models. On any other provider
 * it is ignored; One Code's automatic same-provider role profile then chooses the
 * default unless the user overrides it with `subagentModel`.
 *
 * The value is a spec, not a model: "sonnet", "inherit", or "provider/id" all
 * pass through to resolveSubagentModel, which owns the semantics.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { autoModeSettingsPaths } from "../auto-mode/config.ts";

export interface SubagentDefault {
	spec: string;
	/** Which knob set it, for notices. */
	source: "subagentModel setting" | "CLAUDE_CODE_SUBAGENT_MODEL";
}

interface SettingsFile {
	subagentModel?: unknown;
	env?: Record<string, unknown>;
}

function readSettings(path: string): SettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SettingsFile;
	} catch {
		return undefined;
	}
}

export function loadSubagentDefault(home: string, env: NodeJS.ProcessEnv = process.env): SubagentDefault | undefined {
	let setting: string | undefined;
	let settingsEnv: string | undefined;

	// Lowest precedence first, so managed settings override user settings.
	for (const path of autoModeSettingsPaths(home)) {
		const file = readSettings(path);
		if (!file) continue;
		if (typeof file.subagentModel === "string" && file.subagentModel.trim()) {
			setting = file.subagentModel.trim();
		}
		const fromEnvBlock = file.env?.CLAUDE_CODE_SUBAGENT_MODEL;
		if (typeof fromEnvBlock === "string" && fromEnvBlock.trim()) {
			settingsEnv = fromEnvBlock.trim();
		}
	}

	if (setting) return { spec: setting, source: "subagentModel setting" };

	const fromEnv = env.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
	if (fromEnv) return { spec: fromEnv, source: "CLAUDE_CODE_SUBAGENT_MODEL" };
	if (settingsEnv) return { spec: settingsEnv, source: "CLAUDE_CODE_SUBAGENT_MODEL" };

	return undefined;
}

/**
 * The configured default that actually applies to this session.
 *
 * `subagentModel` is One Code's own setting — the user told *this* harness what
 * subagents run on, so it applies on any provider. `CLAUDE_CODE_SUBAGENT_MODEL`
 * was written for Claude Code, almost always as an Anthropic alias ("sonnet"),
 * so it applies only when the session is already on a Claude model — borrowing
 * it elsewhere silently moved subagent work off the provider the user chose
 * for this session (observed live: an opencode deepseek session's subagents
 * landing on claude-sonnet-5 because a settings `env` block said "sonnet").
 */
export function applicableSubagentDefault(
	configured: SubagentDefault | undefined,
	sessionModel: { provider: string; id: string } | undefined,
): SubagentDefault | undefined {
	if (!configured || configured.source === "subagentModel setting") return configured;
	if (!sessionModel) return configured;
	const claudeFamily = sessionModel.provider === "anthropic" || /claude/i.test(sessionModel.id);
	return claudeFamily ? configured : undefined;
}

/**
 * Persist `subagentModel` in the *user* settings file, preserving every other
 * key. `undefined` removes the setting. Always user scope, like the loader:
 * the default may move subagent work to another provider, so it lives where
 * only the user writes — never in a project file (see the module comment).
 *
 * Unlike loading, this throws on a malformed file: a lenient read merely
 * skips a setting, but a lenient write would replace the user's whole
 * settings file with only ours.
 */
export function persistSubagentModel(spec: string | undefined, home: string): void {
	const path = join(home, ".claude", "settings.json");
	let file: Record<string, unknown> = {};
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${path}: root must be a JSON object`);
		}
		file = parsed as Record<string, unknown>;
	}
	if (spec === undefined) delete file.subagentModel;
	else file.subagentModel = spec;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}
