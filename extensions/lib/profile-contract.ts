/**
 * What a profile supplies to the base harness (types only). One Code's own
 * profile is `profile/index.ts` at the repo root; a product replaces that
 * folder with its own implementation of this contract
 * (working-docs/decisions/bi-fork.md, working-docs/features/profiles/).
 *
 * The contract grows phase by phase as text, brand and catalogs move out of
 * the base. Today it carries the feature and tool switches and the extra
 * extensions child sessions load.
 */

import type { FeatureId } from "./features.ts";

/** A profile's switches for one tool, by its registered name. Omitted fields keep the base's choice. */
export interface ToolSwitch {
	/** false: the tool is never registered, never active, and a call to it is denied. */
	enabled?: boolean;
	/** true: behind `tool_search`; false: in the tool list from the first request. Fixed at load. */
	deferred?: boolean;
	/** true: runs without a permission prompt, like `tool_search` and `skill`. */
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
	 * product's own package.
	 */
	childExtensions: readonly string[];
}
