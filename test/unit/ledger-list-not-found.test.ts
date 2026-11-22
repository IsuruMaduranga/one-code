/**
 * A body that keeps its conversation where the ledger does not look (pi-ai's
 * `pi-messages`: `{ model, context, options }`, the list at
 * `context.messages`) goes out whole on every request. A record with
 * `covers` made the context hook cut to the tail, and the splice had no list
 * to put back.
 */
import { describe, expect, it } from "vitest";
import { LedgerSim, type SimMessage } from "./helpers/ledger-sim.ts";

type Wire = { messages: { role: string; content: { text: string }[] }[] };

class PiMessagesSim extends LedgerSim {
	render(tail: SimMessage[], cap = 1000): never {
		const sent = tail.filter((m) => !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")));
		return {
			model: this.model.id,
			context: { tools: this.tools.map((tool) => ({ ...tool })), messages: sent.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] })) },
			options: { maxTokens: cap, sessionId: this.sessionId },
		} as never;
	}
}

describe("an API whose body keeps its list where the ledger does not look", () => {
	it("sends the whole conversation on every request and adds no field", async () => {
		const s = new PiMessagesSim();
		s.model = { api: "pi-messages", provider: "radius", id: "auto" };
		await s.sessionStart();
		const conversation = (payload: unknown) => (payload as { context: Wire }).context.messages.map((m) => `${m.role}:${m.content[0].text}`);
		s.message("user", "U1");
		const first = await s.request("A1");
		s.message("user", "U2");
		const second = await s.request("A2");
		s.message("user", "U3");
		const third = await s.request("A3");
		expect(conversation(first)).toEqual(["user:U1"]);
		expect(conversation(second)).toEqual(["user:U1", "assistant:A1", "user:U2"]);
		expect(conversation(third)).toEqual(["user:U1", "assistant:A1", "user:U2", "assistant:A2", "user:U3"]);
		expect(second).not.toHaveProperty("messages");
		expect(s.plans.map((plan) => plan.epoch)).toEqual([true, true, true]);
	});
});
