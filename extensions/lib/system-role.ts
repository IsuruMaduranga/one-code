/**
 * Which models get Claude Code's mid-conversation `role: "system"` message,
 * and in which wire shape (pure). One function for the system-prompt builder,
 * the reminder hook and the tool hook, so all three agree on every request.
 *
 * The gate is pi's model catalog flag `compat.supportsMidConvoSystemMessages`
 * alone, no list of our own: pi owns the per-model facts and adds models as it
 * confirms them (`working-docs/decisions/tools.md`, "Claude Code's request
 * shape, on every model pi flags for it"). Haiku is never in it: Anthropic
 * rejects the role there (findings §52). Every unflagged model keeps the
 * context in the first user message.
 */

/** The wire shape a system message takes: Anthropic `system`, OpenAI Responses `input`, or Chat Completions `messages`. */
export type SystemRoleLayout = "anthropic" | "responses" | "completions";

/** The fields of a pi `Model` the gate reads. */
export interface SystemRoleModel {
	id: string;
	api: string;
	compat?: unknown;
}

const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

export function systemRoleLayout(model: SystemRoleModel | undefined): SystemRoleLayout | undefined {
	if (!model) return undefined;
	const compat = model.compat as { supportsMidConvoSystemMessages?: unknown } | undefined;
	if (compat?.supportsMidConvoSystemMessages !== true) return undefined;
	if (model.api === "anthropic-messages") return model.id.includes("haiku") ? undefined : "anthropic";
	if (RESPONSES_APIS.has(model.api)) return "responses";
	if (model.api === "openai-completions") return "completions";
	return undefined;
}
