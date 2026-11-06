/**
 * What the system prompt needs from a profile (types only): the base places
 * the computed blocks (the tool list, the memory section, appended text, the
 * working-directory line, the budget line) and the profile supplies every
 * word around and inside them (working-docs/features/profiles/).
 *
 * Every function must be pure: for a fixed session the prompt is rebuilt each
 * turn and must come out byte-identical (prompt-cache stability).
 */

import type { PromptTier } from "../lib/model-tier.ts";

/** What a section may depend on: all of it fixed for the session (or until the model changes). */
export interface SystemPromptSession {
	tier: PromptTier;
	/** False when the session model runs without the task tools (lib/model-tier.ts taskToolsEnabled). */
	taskTools: boolean;
	/** The session's active tools, as pi selects them; undefined before pi reports them. */
	tools: readonly string[] | undefined;
}

export interface SystemPromptText {
	/** This session's scratchpad is not the one message 1 names (a /fork is a new session). */
	scratchpadMoved(p: { dir: string }): string;
	/** The sections before the tool list, in order. */
	lead(session: SystemPromptSession): string[];
	/** The sections after the memory section, in order. */
	tail(session: SystemPromptSession): string[];
	/** The memory section for the session's auto-memory folder (no section while auto-memory is off). */
	memory(dir: string, session: SystemPromptSession): string;
	/** The tool list: each active tool's one-line snippet, then the guidelines the tools contribute. */
	toolList(tools: readonly { name: string; snippet: string }[], guidelines: readonly string[]): string;
	/** The line naming the working directory, after any appended text. */
	cwdLine(cwd: string): string;
}

/**
 * A section another extension adds (a product's domain section, for one),
 * announced on SYSTEM_PROMPT_SECTION_CHANNEL while extensions load. `render`
 * must be pure in the session; an undefined result leaves the section out
 * for that session (a tier it does not serve).
 */
export interface SystemPromptSection {
	/** Unique per section; a second announcement with the same id replaces the first. */
	id: string;
	/** `lead`: after the profile's lead sections, before the tool list; `tail`: at the very end of the tail. */
	place: "lead" | "tail";
	render(session: SystemPromptSession): string | undefined;
}

export const SYSTEM_PROMPT_SECTION_CHANNEL = "one-code:system-prompt-section";
