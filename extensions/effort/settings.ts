/** Effort defaults and Claude Code 2.1.296's save contract (pure fs, no pi imports). */
import { readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";

const PERSISTED_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type PersistedEffort = (typeof PERSISTED_LEVELS)[number];

export function isPersistedEffort(level: string): level is PersistedEffort {
	return (PERSISTED_LEVELS as readonly string[]).includes(level);
}

/** Use pi's native per-model key so its startup precedence and clamping still apply. */
export function saveEffort(path: string, provider: string, modelId: string, level: PersistedEffort | undefined): void {
	const file = readSettingsForWrite(path);
	const previous = file.modelThinkingLevels;
	if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
		throw new Error(`${path}: modelThinkingLevels must be a JSON object`);
	}
	const levels = { ...(previous as Record<string, unknown> | undefined) };
	const key = `${provider}/${modelId}`;
	if (level === undefined) delete levels[key];
	else levels[key] = level;
	if (Object.keys(levels).length) file.modelThinkingLevels = levels;
	else delete file.modelThinkingLevels;
	writeSettings(path, file);
}

const DESCRIPTIONS: Record<string, string> = {
	low: "Quick, straightforward implementation with minimal overhead",
	medium: "Balanced approach with standard implementation and testing",
	high: "Comprehensive implementation with extensive testing and documentation",
	xhigh: "Deeper reasoning than high, just below maximum (on supported models)",
	max: "Maximum capability with deepest reasoning. May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.",
};

/** The ordinary local response, without organization or environment overrides. */
export function effortSetMessage(level: PersistedEffort | "max", saved: boolean): string {
	return `Set effort level to ${level} (${saved ? "saved as your default for new sessions" : "this session only"}): ${DESCRIPTIONS[level]}`;
}
