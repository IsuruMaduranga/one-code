/**
 * The classifier request the auto-mode prompt tests build payloads from
 * (auto-mode-classifier and One Code's auto-mode-classifier-wording).
 */
import { loadAutoModeConfig } from "../../../extensions/lib/rules/auto-mode-config.ts";
import type { ClassifyRequest } from "../../../extensions/safety/permissions/auto-mode/prompt.ts";

/** The built-in Environment: no settings file at this home, so the profile's default. */
export const DEFAULT_ENVIRONMENT = loadAutoModeConfig("/nonexistent-home-for-tests").environment;

/** A request to classify `rm -rf /tmp/x` after the user asked to clean that folder up. */
export const CLEAN_UP_REQUEST: ClassifyRequest = {
	toolName: "bash",
	transcript: [
		{ kind: "user", text: "clean up /tmp/x" },
		{ kind: "tool", tool: "bash", input: { command: "rm -rf /tmp/x" } },
	],
	userMessages: ["clean up /tmp/x"],
	username: "tester",
	environment: DEFAULT_ENVIRONMENT,
};
