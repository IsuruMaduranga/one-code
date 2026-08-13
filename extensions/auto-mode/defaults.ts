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
