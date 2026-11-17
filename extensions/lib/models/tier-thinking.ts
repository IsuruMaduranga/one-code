/**
 * When the profile's per-tier thinking level (`Profile.defaultThinkingLevels`,
 * lib/profile/thinking-defaults.ts) applies, and when the user's choice wins.
 * Pure: no pi imports; the effort feature (ui/effort) and the subagent runner
 * act on the answers.
 *
 * The level is part of every request (Anthropic's effort, OpenAI's and
 * OpenRouter's `reasoning.effort`), so it is set only where an epoch opens
 * anyway: before a new session's first request, and at a model switch. It
 * is applied with pi's `setThinkingLevel`, which records it on the branch
 * (a resume restores it) and never writes the user's settings. pi fits the
 * level to the model, so the level that runs can be higher than the one
 * declared (DeepSeek V4 Flash has no `low`, and runs `high`).
 *
 * The user's choice wins in four forms: a level saved for the model (pi's
 * `modelThinkingLevels`), pi's global `defaultThinkingLevel`, a launch flag
 * (lib/profile/pi-thinking-flags.ts), and a level picked in the session
 * (shift+tab, `/effort`, an RPC client's `set_thinking_level`). The last is
 * read from the branch (`levelSource`): pi records every level change as a
 * `thinking_level_change` entry, and the default (and `/effort`) records a
 * `one-code:state` entry right after its own, so resume, `/fork` and `/tree`
 * see who set the level without any process state.
 */

import { type EntryLike, readRecord } from "../request/ledger/records.ts";
import type { ThinkingLevelName } from "../profile/thinking-defaults.ts";

/** The `one-code:state` key the default records under: `{ source, level }` after each level it sets. */
export const TIER_THINKING_STATE = "tier-thinking";

/** pi's level when nothing else sets one (pi-coding-agent `core/defaults.js` DEFAULT_THINKING_LEVEL). */
export const PI_DEFAULT_THINKING_LEVEL: ThinkingLevelName = "medium";

/**
 * Who set the session's level: pi's own resolution (`pi`), the profile's
 * tier default (`default`), or the user in this session (`user`).
 */
export type LevelSource = "pi" | "default" | "user";

/** What is recorded after a level is set: who the level now belongs to (`/effort` records `user` even for the level already in force). */
export interface TierThinkingState {
	source: LevelSource;
	level: string;
}

function recordedSource(entry: EntryLike): LevelSource | undefined {
	const record = readRecord(entry);
	if (record?.kind !== "state" || record.data.key !== TIER_THINKING_STATE) return undefined;
	const value = record.data.value as Partial<TierThinkingState> | undefined;
	return value?.source === "default" || value?.source === "pi" || value?.source === "user" ? value.source : undefined;
}

/**
 * Who set the level the branch runs at. A `thinking_level_change` right
 * after a `model_change` (or first on the branch) is pi's own: the level a
 * new session resolves, or a model switch carrying or fitting the level, so
 * it keeps the source it had. Any other change is the user's, unless a
 * state entry follows it and names another source. A level pi itself records on a `/tree`
 * switch reads as the user's too: the safe side, since the default then
 * stays out.
 */
export function levelSource(branch: readonly unknown[]): LevelSource {
	let source: LevelSource = "pi";
	let previous: EntryLike | undefined;
	for (const item of branch as EntryLike[]) {
		if (item.type === "thinking_level_change") {
			if (previous !== undefined && previous.type !== "model_change") source = "user";
		} else {
			source = recordedSource(item) ?? source;
		}
		previous = item;
	}
	return source;
}

/** Whether the branch holds a conversation: a request went out, so its level is the branch's own. */
export function branchHasMessages(branch: readonly unknown[]): boolean {
	return (branch as EntryLike[]).some((entry) => entry.type === "message");
}

/** The user's level choices outside the session, as pi's settings and launch flags carry them. */
export interface LevelChoices {
	/** The level saved for the model (pi's `modelThinkingLevels["provider/id"]`). */
	saved?: string;
	/** pi's global `defaultThinkingLevel`. */
	globalDefault?: string;
	/** A launch flag set the level (`launchThinkingFlag`). */
	launchFlag: boolean;
}

/**
 * The choices pi's effective settings (`pi.getSettings()`, or a session's
 * settings manager) and the launch carry for `model`. A level `/effort`
 * saved in this process is not in pi's settings until a restart; it was
 * picked in the session, so `levelSource` already reads it as the user's.
 */
export function levelChoices(settings: unknown, model: { provider: string; id: string }, launchFlag: boolean): LevelChoices {
	const { modelThinkingLevels, defaultThinkingLevel } = (settings ?? {}) as { modelThinkingLevels?: unknown; defaultThinkingLevel?: unknown };
	const saved = modelThinkingLevels !== null && typeof modelThinkingLevels === "object" ? (modelThinkingLevels as Record<string, unknown>)[`${model.provider}/${model.id}`] : undefined;
	return {
		...(typeof saved === "string" ? { saved } : {}),
		...(typeof defaultThinkingLevel === "string" ? { globalDefault: defaultThinkingLevel } : {}),
		launchFlag,
	};
}

/** A level to set, and who it belongs to afterwards (recorded as `TierThinkingState`). */
export interface TierThinkingAction {
	level: ThinkingLevelName;
	source: Exclude<LevelSource, "user">;
}

/**
 * What to set at a boundary: `start`, a new session before its first
 * request; `switch`, after pi switched the model and set its own level;
 * `child`, a subagent whose runner passed no level. `declared` is the
 * level the profile declares for the (new) model's tier; `source` is
 * `levelSource` of the branch (pi's own switch entries keep it, so it is
 * who set the level before the switch). Undefined: leave pi's level.
 *
 * A level the user chose in the session survives a switch (pi carries it,
 * and the default stays out). A switch from a tier with a default to one
 * without, while the level is still the default's, gives the level back
 * to pi: what pi would have used without the default, its own `medium`
 * (a saved or global level would have stopped the default before).
 */
export function tierThinkingAction(input: { boundary: "start" | "switch" | "child"; declared: ThinkingLevelName | undefined; choices: LevelChoices; source: LevelSource }): TierThinkingAction | undefined {
	const { boundary, declared, choices, source } = input;
	if (choices.launchFlag || choices.saved !== undefined || choices.globalDefault !== undefined) return undefined;
	if (source === "user") return undefined;
	if (declared !== undefined) return { level: declared, source: "default" };
	if (boundary === "switch" && source === "default") return { level: PI_DEFAULT_THINKING_LEVEL, source: "pi" };
	return undefined;
}

/**
 * The level `/effort auto` restores once the saved level is cleared: pi's
 * global default, else the tier's default, else pi's `medium`. Auto drops
 * the user's own pick, so the default follows later switches again.
 */
export function autoThinkingAction(input: { declared: ThinkingLevelName | undefined; globalDefault: string | undefined }): { level: string; source: Exclude<LevelSource, "user"> } {
	if (input.globalDefault !== undefined) return { level: input.globalDefault, source: "pi" };
	if (input.declared !== undefined) return { level: input.declared, source: "default" };
	return { level: PI_DEFAULT_THINKING_LEVEL, source: "pi" };
}
