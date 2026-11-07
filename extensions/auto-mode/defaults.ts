/**
 * Built-in auto-mode configuration helpers.
 *
 * The classifier ruleset is not configurable prose lists: it is the profile's
 * fixed text (One Code's: Claude Code's classifier; working-docs/decisions/auto-mode.md).
 * The one customization surface Claude Code exposes, and the only one we
 * expose, is the `## Environment` section: `defaultEnvironment()`
 * (classifier-prompt.ts) is the profile's default slot text, and a user's
 * `autoMode.environment` entries replace it.
 */

/**
 * The `**Name**:` head of an Environment slot line, or undefined for header
 * ("### Org-wide") and prose entries. Used to tell a full slot replacement
 * (the wizard's normal output) from a partial one that silently drops slots.
 */
export function slotName(line: string): string | undefined {
	return line.match(/^\*\*(.+?)\*\*:/)?.[1];
}
