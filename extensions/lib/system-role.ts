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

type WireMessage = { role?: unknown; content?: unknown };

/** pi's directive-only effort message: a system message with no content, which cannot carry a cache mark. */
function isEmptySystemMessage(message: WireMessage): boolean {
	return message?.role === "system" && Array.isArray(message.content) && message.content.length === 0;
}
type WirePart = { type?: unknown; text?: unknown; cache_control?: unknown };

/**
 * The payload with the moved context blocks lifted off the user message that
 * carries them and joined, unwrapped and a blank line apart, into one system
 * message placed right after it, in the API's own shape (Claude Code's layout,
 * `decisions/tools.md`). Blocks are found by their exact text, never by
 * position: a fork's request drops the parent's first message, and then nothing
 * moves. On Anthropic, when the new message ends the request's content (only
 * pi's empty effort messages follow), the cache mark moves from the user
 * message onto it, as Claude Code marks its system message, so the first
 * request caches the context too.
 * Undefined when nothing changes.
 */
export function withSystemRoleContext(
	payload: Record<string, unknown>,
	layout: SystemRoleLayout,
	moved: readonly MovedBlock[],
	role: "system" | "developer",
): Record<string, unknown> | undefined {
	if (moved.length === 0) return undefined;
	const key = layout === "responses" ? "input" : "messages";
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

	const last = messages.slice(index + 1).every(isEmptySystemMessage);
	let user: WireMessage = { ...carrier, content: kept };
	let system: Record<string, unknown>;
	if (layout === "anthropic") {
		const block: Record<string, unknown> = { type: "text", text };
		const tail = kept[kept.length - 1];
		if (last && tail?.cache_control !== undefined) {
			const { cache_control, ...unmarked } = tail;
			block.cache_control = cache_control;
			user = { ...carrier, content: [...kept.slice(0, -1), unmarked] };
		}
		system = { role: "system", content: [block] };
	} else {
		system = { role, content: text };
	}
	return { ...payload, [key]: [...messages.slice(0, index), user, system, ...messages.slice(index + 1)] };
}
