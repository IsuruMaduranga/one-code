/**
 * The Agent tool's argument preparation (pure), run by pi before schema
 * validation. `task` is required in the schema: a weak model read an optional
 * task as optional and sent run options with no task, again and again
 * (DeepSeek V3.2, live, 2026-10-05). Two callers still validate:
 *
 * - a Claude Code-trained model writes the task as `prompt`, which is moved
 *   into `task` (TOOL-FIDELITY-REVIEW-2026-09-07 H1);
 * - `action: "list"` only browses the catalog and needs no task.
 *
 * Anything that is not a plain object is passed through for the validator to
 * reject as it does today.
 */
export function prepareAgentArguments(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	if (typeof input.task === "string" && input.task.length > 0) return args;
	if (typeof input.prompt === "string" && input.prompt.length > 0) return { ...input, task: input.prompt };
	if (input.action === "list" && input.task === undefined) return { ...input, task: "" };
	return args;
}
