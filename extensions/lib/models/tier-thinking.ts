/**
 * When the profile's per-tier thinking level (`Profile.defaultThinkingLevels`,
 * lib/profile/thinking-defaults.ts) applies, and when the user's choice wins.
 * The decisions are pure; `tierThinkingAt` gathers their inputs (the
 * profile's levels, the model's tier, the launch flags) for the effort
 * feature (ui/effort) and the subagent runner, which act on the answers.
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
 * `thinking_level_change` entry, and a `one-code:state` entry records who
 * owns the live level after the default sets one, after `/effort`, after
 * every model switch and after a `/tree` move, so resume, `/fork` and `/tree`
 * see who set the level without any process state.
 */

import { type EntryLike, readRecord } from "../request/ledger/records.ts";
import type { ThinkingLevelName } from "../profile/thinking-defaults.ts";
import { activeProfile, launchThinkingFlag } from "../profile/profile.ts";
import { modelCapability } from "./model-tier.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

/** The `one-code:state` key recording who owns the live level: `{ source, level }`. */
export const TIER_THINKING_STATE = "tier-thinking";

/** pi's level when nothing else sets one (pi-coding-agent `core/defaults.js` DEFAULT_THINKING_LEVEL). */
export const PI_DEFAULT_THINKING_LEVEL: ThinkingLevelName = "medium";

/**
 * Who set the session's level: pi's own resolution (`pi`), the profile's
 * tier default (`default`), or the user in this session (`user`).
 */
export type LevelSource = "pi" | "default" | "user";

/**
 * Who owns the live level, and the level then live (`/effort` records `user`
 * even for the level already in force). `auto`: `/effort auto` set it, which
 * also ends a launch flag's hold for the rest of the session (a `/tree`
 * move carries it to the new branch).
 */
export interface TierThinkingState {
	source: LevelSource;
	level: string;
	auto?: true;
}

function recordedState(entry: EntryLike): TierThinkingState | undefined {
	const record = readRecord(entry);
	if (record?.kind !== "state" || record.data.key !== TIER_THINKING_STATE) return undefined;
	const value = record.data.value as Partial<TierThinkingState> | undefined;
	const source = value?.source;
	if (source !== "default" && source !== "pi" && source !== "user") return undefined;
	return { source, level: typeof value?.level === "string" ? value.level : "", ...(value?.auto === true ? { auto: true as const } : {}) };
}

/** Who owns the branch's live level, and whether `/effort auto` released a launch flag's level. */
export interface LevelOwnership {
	source: LevelSource;
	launchReleased: boolean;
}

/**
 * Who set the level the branch runs at. A state entry says who owns the
 * live level. A `thinking_level_change` right after a `model_change` (or
 * first on the branch) is pi's own: the level a new session resolves, or a
 * model switch carrying or fitting the level, so it keeps the source. A
 * change to the level already known is no change: pi records the live
 * level again at the next prompt after a `/tree` move. Any other change is
 * the user's (shift+tab, an RPC client), unless a state entry follows it.
 * The model switch handler records a state entry after every switch, so a
 * pick right after a switch never sits next to the `model_change`.
 */
export function levelSource(branch: readonly unknown[]): LevelSource {
	return levelOwnership(branch).source;
}

/**
 * `levelSource`, and whether an `/effort auto` entry is on the branch: the
 * user asked for the default, so a launch flag no longer holds the level.
 */
export function levelOwnership(branch: readonly unknown[]): LevelOwnership {
	let source: LevelSource = "pi";
	let launchReleased = false;
	let level: string | undefined;
	let previous: EntryLike | undefined;
	for (const item of branch as Array<EntryLike & { thinkingLevel?: string }>) {
		if (item.type === "thinking_level_change") {
			const pis = previous === undefined || previous.type === "model_change";
			if (!pis && item.thinkingLevel !== level) source = "user";
			level = item.thinkingLevel;
		} else {
			const state = recordedState(item);
			if (state) {
				({ source, level } = state);
				launchReleased ||= state.auto === true;
			}
		}
		previous = item;
	}
	return { source, launchReleased };
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

/** A level to set (none: leave pi's), and who owns the live level afterwards (recorded as `TierThinkingState`). */
export interface TierThinkingAction {
	level?: ThinkingLevelName;
	source: LevelSource;
}

/**
 * What to set at a boundary: `start`, a new session before its first
 * request; `switch`, after pi switched the model and set its own level;
 * `child`, a subagent whose runner passed no level. `declared` is the
 * level the profile declares for the (new) model's tier; `source` is
 * `levelSource` of the branch (pi's own switch entries keep it, so it is
 * who set the level before the switch; for a child, the parent's).
 *
 * A level the user chose in the session survives a switch (pi carries it,
 * and the default stays out), and a named subagent of such a session keeps
 * pi's own level. A saved, global or launch level is pi's to apply. A
 * switch from a tier with a default to one without, while the level is
 * still the default's, gives the level back to pi: what pi would have used
 * without the default, its own `medium` (a saved or global level would
 * have stopped the default before).
 */
export function tierThinkingAction(input: { boundary: "start" | "switch" | "child"; declared: ThinkingLevelName | undefined; choices: LevelChoices; source: LevelSource }): TierThinkingAction {
	const { boundary, declared, choices, source } = input;
	if (source === "user") return { source };
	if (choices.launchFlag || choices.saved !== undefined || choices.globalDefault !== undefined) return { source: "pi" };
	if (declared !== undefined) return { level: declared, source: "default" };
	if (boundary === "switch" && source === "default") return { level: PI_DEFAULT_THINKING_LEVEL, source: "pi" };
	return { source };
}

/** The level the profile declares for `model`'s capability tier, if any. */
export function declaredLevel(model: Model<Api>): ThinkingLevelName | undefined {
	return activeProfile().defaultThinkingLevels[modelCapability(model).tier];
}

/**
 * `tierThinkingAction` for `model` at a boundary, its inputs gathered: the
 * profile's level for the model's tier, the user's choices in `settings`
 * (pi's effective settings) and the launch flags, unless `/effort auto`
 * released them. `ownership` is the session's (for a child, the parent's).
 */
export function tierThinkingAt(boundary: "start" | "switch" | "child", model: Model<Api>, settings: unknown, ownership: LevelOwnership): TierThinkingAction {
	const launchFlag = !ownership.launchReleased && launchThinkingFlag();
	return tierThinkingAction({ boundary, declared: declaredLevel(model), choices: levelChoices(settings, model, launchFlag), source: ownership.source });
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
