/**
 * What a profile supplies to the base harness (types only). One Code's own
 * profile is `profile/index.ts` at the repo root; a product replaces that
 * folder with its own implementation of this contract
 * (working-docs/decisions/bi-fork.md, working-docs/features/profiles/).
 *
 * The contract grows phase by phase as text, brand and catalogs move out of
 * the base. Today it carries the feature and tool switches, the extra
 * extensions child sessions load, and the text groups moved so far.
 */

import type { AskUserText } from "../ask-user/text.ts";
import type { NotebookText } from "../notebook/text.ts";
import type { SystemPromptText } from "../system-prompt/text.ts";
import type { TasksText } from "../tasks/text.ts";
import type { WorktreeGuardText, WorktreeText } from "../worktree/text.ts";
import type { FeatureId } from "./features.ts";

/**
 * Every text the base shows the model, one group per feature that owns it.
 * A group of an optional feature may be left out when the profile turns that
 * feature off (lib/profile.ts requireText).
 */
export interface ProfileText {
	systemPrompt: SystemPromptText;
	notebook?: NotebookText;
	askUser?: AskUserText;
	tasks?: TasksText;
	worktree?: WorktreeText;
	/** Used by the worktree tools, subagents and workflows (each guards isolated sessions with it). */
	worktreeGuard?: WorktreeGuardText;
}

/** A profile's switches for one tool, by its registered name. Omitted fields keep the base's choice. */
export interface ToolSwitch {
	/**
	 * false: the tool is never registered, never active, and a call to it is
	 * denied. The harness's plumbing (`PINNED_TOOLS` in lib/profile.ts) can't be
	 * turned off or deferred.
	 */
	enabled?: boolean;
	/** true: behind `tool_search`; false: in the tool list from the first request. Fixed at load. */
	deferred?: boolean;
	/**
	 * true: runs without a permission prompt, like `tool_search` and `skill`.
	 * Plan mode still holds such a tool to its read-only rules.
	 */
	autoAllow?: boolean;
}

export interface Profile {
	/** Features to turn off (`false`); a feature left out stays on. */
	features: Partial<Record<FeatureId, boolean>>;
	/** Per-tool switches, keyed by tool name. */
	tools: Readonly<Record<string, ToolSwitch>>;
	/**
	 * Extension entry files, relative to the profile folder, that in-process
	 * child sessions (subagents, workflow agents) load after the base's own
	 * child extensions. The main session loads a product's extensions from the
	 * product's own package, after the base's. Either way they load after the
	 * request pipeline (`ledger/wire`, cache-marks), so a product extension
	 * must not shape the request tail in a `context` or payload hook; it adds
	 * tools, commands, reminders and prompt sections.
	 */
	childExtensions: readonly string[];
	/** The model-facing text, by owning feature. */
	text: ProfileText;
}
