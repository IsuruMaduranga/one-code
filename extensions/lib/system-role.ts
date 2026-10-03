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

/** pi-ai's Responses APIs: requests carry `input` items and flat `{ type, name }` tools. */
export const RESPONSES_APIS: ReadonlySet<string> = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

/** The wire shape of a pi API, for the three shapes One Code rewrites; undefined for the rest (Google, Bedrock). */
export function wireShape(api: string): SystemRoleLayout | undefined {
	if (api === "anthropic-messages") return "anthropic";
	if (RESPONSES_APIS.has(api)) return "responses";
	if (api === "openai-completions") return "completions";
	return undefined;
}

/** The payload field that holds the conversation for a wire shape. */
export function messagesKey(shape: SystemRoleLayout): "input" | "messages" {
	return shape === "responses" ? "input" : "messages";
}

export function systemRoleLayout(model: SystemRoleModel | undefined): SystemRoleLayout | undefined {
	if (!model) return undefined;
	const compat = model.compat as { supportsMidConvoSystemMessages?: unknown } | undefined;
	if (compat?.supportsMidConvoSystemMessages !== true) return undefined;
	if (model.api === "anthropic-messages" && model.id.includes("haiku")) return undefined;
	return wireShape(model.api);
}

/** One context block that moves: its text as injected on the user message, and its text inside the system message. */
export interface MovedBlock {
	/** The block exactly as the user message carries it (`<system-reminder>` frame and suffix included). */
	framed: string;
	/** The unwrapped text, as Claude Code's system message joins it. */
	inner: string;
}

/**
 * The role a system message takes on the OpenAI APIs: pi's own rule per API
 * (`developer` for a reasoning model that accepts it, else `system`).
 */
export function instructionRole(layout: SystemRoleLayout, model: { reasoning?: boolean; compat?: unknown }): "system" | "developer" {
	if (layout === "anthropic") return "system";
	const developer = (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
	const accepts = layout === "responses" ? developer !== false : developer === true;
	return model.reasoning && accepts ? "developer" : "system";
}

/** A wire message and content part, as far as the payload rewrites read them. */
export type WireMessage = { role?: unknown; type?: unknown; content?: unknown; output?: unknown; call_id?: unknown; tool_call_id?: unknown };
export type WirePart = { type?: unknown; text?: unknown; content?: unknown; tool_use_id?: unknown; cache_control?: unknown };

/** A system message with `text` in the API's own shape. */
export function systemMessage(layout: SystemRoleLayout, role: "system" | "developer", text: string): WireMessage {
	return layout === "anthropic" ? { role: "system", content: [{ type: "text", text }] } : { role, content: text };
}

/**
 * The payload with the moved context blocks lifted off the user message that
 * carries them and joined, unwrapped and a blank line apart, into one system
 * message placed right after it, in the API's own shape (Claude Code's layout,
 * `decisions/tools.md`). Blocks are found by their exact text, never by
 * position: a fork's request drops the parent's first message, and then nothing
 * moves. The cache mark is reseated afterwards (anthropic-payload.ts
 * reseatMessageMark). Undefined when nothing changes.
 */
export function withSystemRoleContext(
	payload: Record<string, unknown>,
	layout: SystemRoleLayout,
	moved: readonly MovedBlock[],
	role: "system" | "developer",
): Record<string, unknown> | undefined {
	if (moved.length === 0) return undefined;
	const key = messagesKey(layout);
	const messages = payload[key];
	if (!Array.isArray(messages)) return undefined;
	const wanted = new Set(moved.map((block) => block.framed));
	const index = messages.findIndex(
		(message: WireMessage) => message?.role === "user" && Array.isArray(message.content) && (message.content as WirePart[]).some((part) => wanted.has(part?.text as string)),
	);
	if (index === -1) return undefined;

	const carrier = messages[index] as WireMessage & { content: WirePart[] };
	const found = new Set<string>();
	const kept = carrier.content.filter((part) => {
		const text = part?.text;
		if (typeof text !== "string" || !wanted.has(text) || found.has(text)) return true;
		found.add(text);
		return false;
	});
	const text = moved
		.filter((block) => found.has(block.framed))
		.map((block) => block.inner)
		.join("\n\n");

	const user: WireMessage = { ...carrier, content: kept };
	return { ...payload, [key]: [...messages.slice(0, index), user, systemMessage(layout, role, text), ...messages.slice(index + 1)] };
}
