/**
 * Claude model ids in any provider's spelling (pure, no imports), for the
 * gates that must not pull in the tier module's catalog graph.
 */

/**
 * A Claude model id in any provider's spelling (`claude-opus-5-5`,
 * `claude-haiku-4-5-20251001`, `anthropic/claude-sonnet-5.5`, Bedrock's
 * `us.anthropic.claude-fable-5-1-v1`): family, major, and minor when the id
 * has one. A dated suffix is never read as the minor version. Undefined for
 * anything else. `parseClaudeVersion` (model-tier.ts) stays first-party only, for the gates.
 */
export function parseClaudeId(id: string): { family: "opus" | "sonnet" | "haiku" | "fable"; major: number; minor?: number } | undefined {
	const match = id.match(/(?:^|[/.])claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?(?=$|[-@:[])/);
	if (!match) return undefined;
	return { family: match[1] as "opus" | "sonnet" | "haiku" | "fable", major: Number(match[2]), ...(match[3] ? { minor: Number(match[3]) } : {}) };
}

/** The Claude family of a model id in any provider's spelling. */
export function claudeFamily(id: string): "opus" | "sonnet" | "haiku" | "fable" | undefined {
	return parseClaudeId(id)?.family;
}
