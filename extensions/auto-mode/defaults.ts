/**
 * Built-in auto-mode configuration defaults.
 *
 * The ruleset itself is no longer configurable prose lists — the classifier
 * ruleset is a fixed monolith matching Claude Code's classifier (see
 * classifier-prompt.ts and docs/decisions/auto-mode.md). The one customization
 * surface Claude Code exposes, and the only one we expose, is the `## Environment` section:
 * `DEFAULT_ENVIRONMENT` is CC's default slot text, and a user's `autoMode.environment`
 * entries replace it. Re-exported here so config.ts has a single stable import
 * point rather than reaching into the generated prompt module.
 */

export { DEFAULT_ENVIRONMENT } from "./classifier-prompt.ts";

/**
 * The `**Name**:` head of an Environment slot line, or undefined for header
 * ("### Org-wide") and prose entries. Used to tell a full slot replacement
 * (the wizard's normal output) from a partial one that silently drops slots.
 */
export function slotName(line: string): string | undefined {
	return line.match(/^\*\*(.+?)\*\*:/)?.[1];
}
