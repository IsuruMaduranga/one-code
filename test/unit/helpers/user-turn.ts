import { AsyncLocalStorage } from "node:async_hooks";
import type { FakePi } from "./fake-pi.ts";

/** pi's async preflight emits agent_start in the send call's async context. */
export function captureUserTurns(fake: FakePi): () => Promise<void> {
	let turn: (() => Promise<unknown>) | undefined;
	const send = fake.pi.sendUserMessage as (content: unknown, options?: unknown) => void;
	fake.pi.sendUserMessage = (content: unknown, options?: unknown) => {
		send(content, options);
		turn = AsyncLocalStorage.bind(() => fake.fire("agent_start", {}));
	};
	return async () => {
		// One-shot senders first yield to any previous command's settlement.
		for (let i = 0; i < 20 && !turn; i++) await Promise.resolve();
		if (!turn) throw new Error("No submitted user turn to start");
		const start = turn;
		turn = undefined;
		await start();
	};
}
