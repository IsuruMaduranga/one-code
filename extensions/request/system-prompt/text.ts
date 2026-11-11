/**
 * What the system prompt needs from a profile, and the base's own frames.
 * The base places and words the computed blocks (the tool list, appended
 * text, the working-directory line, the budget line); the profile supplies
 * the sections before and after the tool list and the memory section.
 *
 * Every function must be pure: for a fixed session the prompt is rebuilt each
 * turn and must come out byte-identical (prompt-cache stability).
 */

import { brandedId } from "../../lib/profile/brand.mjs";
import type { PromptTier } from "../../lib/models/model-tier.ts";

/** What a section may depend on: all of it fixed for the session (or until the model changes). */
export interface SystemPromptSession {
	tier: PromptTier;
	/** False when the session model runs without the task tools (lib/models/model-tier.ts taskToolsEnabled). */
	taskTools: boolean;
	/** The session's active tools, as pi selects them; undefined before pi reports them. */
	tools: readonly string[] | undefined;
}

export interface SystemPromptText {
	/** The sections before the tool list, in order. */
	lead(session: SystemPromptSession): string[];
	/** The sections after the memory section, in order. */
	tail(session: SystemPromptSession): string[];
	/** The memory section for the session's auto-memory folder (no section while auto-memory is off). */
	memory(dir: string, session: SystemPromptSession): string;
}

/** The tool list: each active tool's one-line snippet, then the guidelines the tools contribute. */
export function toolList(tools: readonly { name: string; snippet: string }[], guidelines: readonly string[]): string {
	const list = tools.length > 0 ? tools.map(({ name, snippet }) => `- ${name}: ${snippet}`).join("\n") : "(none)";
	const guidelinesBlock = guidelines.length > 0 ? `\n\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}` : "";
	return `# Available tools\n${list}${guidelinesBlock}`;
}

/** The line naming the working directory, after any appended text. */
export const cwdLine = (cwd: string): string => `Current working directory: ${cwd}`;

/** This session's scratchpad is not the one message 1 names (a /fork is a new session). */
export const scratchpadMoved = ({ dir }: { dir: string }): string =>
	`This session's scratchpad directory is now ${dir}. Use it for temporary files instead of the scratchpad named earlier in this conversation.`;

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

export const SYSTEM_PROMPT_SECTION_CHANNEL = brandedId("system-prompt-section");
