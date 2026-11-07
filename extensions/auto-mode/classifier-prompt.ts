/**
 * The auto-mode classifier's prompt, assembled from the profile's `classifier`
 * text (One Code's: Claude Code's classifier prompt, generated into
 * profile/text/auto-mode/ruleset.ts, never hand-edited). The base owns the
 * insertion points: the `## Environment` slot lines (AutoModeConfig.environment),
 * the user's rules appended at the end of the hard-deny, soft-deny and allow
 * lists (exactly where Claude Code's own `/auto-mode-setup` config lands), the
 * username, and the user's instruction file. Everything else is the profile's
 * text, held byte-stable (working-docs/decisions/auto-mode.md).
 *
 * Pure: no pi imports.
 */

import { requireText } from "../lib/profile.ts";
import type { ClassifierText } from "./text.ts";

/** The profile's classifier text. */
export function classifierText(): ClassifierText {
	return requireText("classifier");
}

/**
 * The profile's default `## Environment` slot lines, prefix-less (the settings
 * format: `autoMode.environment` values carry no "- " bullet; the prompt
 * renders it). Passing them back yields the default ruleset exactly; a user's
 * own `environment` entries replace them.
 */
export function defaultEnvironment(): string[] {
	return [...classifierText().defaultEnvironment];
}

/** User rule extras appended to the embedded lists. */
export interface RuleExtras {
	hardDeny?: string[];
	softDeny?: string[];
	allow?: string[];
}

const appended = (entries: string[] | undefined): string =>
	entries && entries.length > 0 ? `\n${entries.map((entry) => `- ${entry}`).join("\n")}` : "";

/**
 * The classifier ruleset with the given Environment slot lines spliced in and
 * any user rule extras appended at the insertion points. The default
 * environment with no extras is the profile's default prompt.
 */
export function buildRuleset(environment: readonly string[], extras?: RuleExtras): string {
	const text = classifierText();
	return (
		text.rulesetHead +
		environment.map((entry) => `- ${entry}`).join("\n") +
		text.hardSection +
		appended(extras?.hardDeny) +
		text.softSection +
		appended(extras?.softDeny) +
		text.allowSection +
		appended(extras?.allow) +
		text.rulesetTail
	);
}

/** The Session Context block (Claude Code's `system[2]`), with the live username injected. */
export function renderSessionContext(username: string): string {
	return classifierText().sessionContext.split("__USERNAME__").join(username);
}

/**
 * The user-role framing block around the user's instruction file (Claude
 * Code's msg[0]). The file stays in the USER role, untrusted: the framing
 * itself says generic encouragement is not authorization. "" when there is no
 * file to frame.
 */
export function instructionsFraming(instructions: string | undefined): string {
	if (!instructions?.trim()) return "";
	// Wrapped verbatim (no trim): the framing text is byte-stable, and the
	// content is whatever file the caller holds.
	const { prefix, suffix } = classifierText().instructionsFraming;
	return prefix + instructions + suffix;
}
