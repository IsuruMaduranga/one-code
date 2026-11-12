/**
 * Pure pieces of Claude Code's `/btw` ("by the way") side-question feature: a
 * lightweight, one-off question answered against the current conversation's
 * context while the main agent keeps working. The prompt text is the profile's
 * (text.ts): Claude Code's reminder that frames the answering model as a
 * separate, tool-less instance, prepended to the user's question as the final
 * user message.
 *
 * Kept free of pi imports (pi-ai types only) so the message assembly is
 * unit-tested; the extension owns the model call, the spinner, and the panel.
 */

import type { Api, AssistantMessage, Message, Model, UserMessage } from "@earendil-works/pi-ai";

/** One answered side question, kept for the rest of the session. */
export interface BtwExchange {
	question: string;
	answer: string;
}

/** The model an injected assistant message is attributed to. */
type ModelRef = Pick<Model<Api>, "api" | "provider" | "id">;

/**
 * One exchange as the user/assistant pair a later request carries: the bare
 * question (no reminder) and the answer, as Claude Code threads its side
 * session's history into the next side question. A fork gets the same pairs.
 */
export function exchangeMessages(exchange: BtwExchange, model: ModelRef, timestamp = Date.now()): Message[] {
	const user: UserMessage = { role: "user", content: [{ type: "text", text: exchange.question }], timestamp };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: exchange.answer }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
	return [user, assistant];
}

/** Every earlier exchange, oldest first, as the messages sent before a new side question. */
export function historyMessages(exchanges: readonly BtwExchange[], model: ModelRef, timestamp = Date.now()): Message[] {
	return exchanges.flatMap((exchange) => exchangeMessages(exchange, model, timestamp));
}
