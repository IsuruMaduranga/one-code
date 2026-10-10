/** Which effort levels are saved, and the result text (pure, no pi imports). */

const PERSISTED_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type PersistedEffort = (typeof PERSISTED_LEVELS)[number];

export function isPersistedEffort(level: string): level is PersistedEffort {
	return (PERSISTED_LEVELS as readonly string[]).includes(level);
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
