/** Pure state for resumed-session subagent capability announcements. */

export type SubagentCapability = "models" | "agents" | "delegation";
export interface SubagentBaseline {
	models: string | null;
	agents: string | null;
	delegation: string | null;
	/** Account refusals the narrow tail correction has already communicated. */
	refusedModels: string[];
}

export function emptySubagentBaseline(): SubagentBaseline {
	return { models: null, agents: null, delegation: null, refusedModels: [] };
}

/** Stored baseline validation deliberately permits arbitrary reminder text. */
export function subagentBaseline(value: unknown): SubagentBaseline | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const output = emptySubagentBaseline();
	for (const key of ["models", "agents", "delegation"] as const) {
		if (input[key] !== null && typeof input[key] !== "string") return undefined;
		output[key] = (input[key] as string | null | undefined) ?? null;
	}
	// v1 phase-2 snapshots did not carry this field; absence means no known
	// refusal, not malformed state. Keep the list JSON-safe and deterministic.
	if (input.refusedModels !== undefined && (!Array.isArray(input.refusedModels) || !input.refusedModels.every((model) => typeof model === "string"))) return undefined;
	output.refusedModels = [...new Set((input.refusedModels as string[] | undefined) ?? [])];
	return output;
}

/** A restored first-prepend block is a usable fallback for snapshots predating structured baselines. */
export function subagentBaselineFromStack(stack: readonly { key?: string; text: string }[]): SubagentBaseline {
	const baseline = emptySubagentBaseline();
	const keys: Record<SubagentCapability, string> = {
		models: "subagent-models", agents: "subagent-agents", delegation: "subagent-delegation",
	};
	for (const capability of Object.keys(keys) as SubagentCapability[]) {
		const entry = stack.find((item) => item.key === keys[capability]);
		baseline[capability] = entry?.text ?? null;
	}
	return baseline;
}

export type SubagentAnnouncement =
	| { kind: "none"; baseline: SubagentBaseline }
	| { kind: "standing"; baseline: SubagentBaseline }
	| { kind: "addendum"; text: string; baseline: SubagentBaseline };

/**
 * Fresh sessions may rewrite message 1; resumed sessions must leave its locked
 * block alone and describe a real capability change at the tail instead.
 */
export function planSubagentAnnouncement(input: {
	restored: boolean;
	baseline: SubagentBaseline;
	capability: SubagentCapability;
	text: string | null;
}): SubagentAnnouncement {
	if (input.baseline[input.capability] === input.text) return { kind: "none", baseline: input.baseline };
	const baseline = { ...input.baseline, [input.capability]: input.text };
	if (!input.restored) return { kind: "standing", baseline };
	if (input.text !== null) return { kind: "addendum", text: input.text, baseline };
	return {
		kind: "addendum",
		text: "The subagent delegation guidance previously shown for this conversation is no longer active.",
		baseline,
	};
}
