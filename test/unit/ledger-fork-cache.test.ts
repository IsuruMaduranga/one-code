/**
 * A fork child loads the ledger pair and `fork-cache` together (the runner's
 * order: path extensions, then the inline one). Exactly one of them shapes a
 * request: the ledger when it extends a recorded request, `fork-cache` inside
 * the ledger's epoch otherwise, so the record always holds what went out.
 */
import { describe, expect, it } from "vitest";
import { forkCacheExtension } from "../../extensions/agents/subagents/fork-cache.ts";
import type { RequestCapture } from "../../extensions/lib/side-calls/request-replay.ts";
import { RECORD } from "../../extensions/lib/request/ledger/records.ts";
import { setSecretValues } from "../../extensions/lib/profile/secrets.ts";
import { LedgerSim, type SimMessage } from "./helpers/ledger-sim.ts";

type Handlers = Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
type Wire = { messages: { role: string; content: { text: string }[] }[] };

/** Every text block of a request, one entry per block: a merged user turn shows as two entries. */
const blocks = (payload: unknown) => (payload as Wire).messages.flatMap((m) => m.content.map((c) => `${m.role}:${c.text}`));

class ForkSim extends LedgerSim {
	capture: RequestCapture | undefined;
	load(): void {
		super.load();
		if (!this.capture) return;
		const self = this as unknown as { handlers: Handlers; listeners: Record<string, ((data: unknown) => void)[]> };
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				(self.handlers[event] ??= []).push(handler);
			},
			events: {
				emit: (channel: string, data: unknown) => {
					for (const listener of self.listeners[channel] ?? []) listener(data);
				},
				on: (channel: string, listener: (data: unknown) => void) => {
					(self.listeners[channel] ??= []).push(listener);
				},
			},
			getAllTools: () => this.tools,
			registerTool: () => {},
		};
		forkCacheExtension(this.capture)(pi as never);
	}
	/** pi's emitContext: every `context` handler, then every `context_with_system` handler. */
	async context(): Promise<SimMessage[]> {
		let out = await super.context();
		for (const handler of (this as unknown as { handlers: Handlers }).handlers.context_with_system ?? []) {
			const result = (await handler({ type: "context_with_system", messages: out }, this.ctx())) as { messages?: SimMessage[] } | undefined;
			if (result?.messages) out = result.messages;
		}
		return out;
	}
}

/** The parent's last request as the compaction extension publishes it: the body, and the last context message it covers. */
function captureOf(sent: unknown, lastCovered: SimMessage): RequestCapture {
	return { api: "anthropic-messages", provider: "acme", modelId: "m1", payload: { ...(sent as object), max_tokens: 100_000 }, covers: { role: lastCovered.role, timestamp: lastCovered.timestamp }, sessionId: "s1" };
}

/** A fork of `parent`: a copy of its session file, the /btw exchange, then the task. */
async function forkOf(parent: LedgerSim, capture: RequestCapture): Promise<ForkSim> {
	const fork = new ForkSim();
	fork.entries = parent.entries.map((entry) => ({ ...entry }));
	fork.sessionId = "child";
	(fork as unknown as { clock: number }).clock = 5000;
	fork.capture = capture;
	fork.load();
	await fork.sessionStart("fork");
	fork.message("user", "btw Q");
	fork.message("assistant", "btw A");
	fork.message("user", "fork task");
	return fork;
}

const WHOLE = ["user:U1", "assistant:A1", "user:U2", "user:btw Q", "assistant:btw A", "user:fork task"];

describe("a fork child with the ledger and fork-cache", () => {
	it.each([
		["while the parent's reply streams", (parent: LedgerSim) => parent.requestWithoutReply()],
		["while idle after an interrupted turn", (parent: LedgerSim) => parent.request("partial", "aborted")],
	])("sends the conversation once, and keeps it, for a /btw fork taken %s", async (_name, lastRequest) => {
		const parent = new LedgerSim();
		await parent.sessionStart();
		parent.message("user", "U1");
		await parent.request("A1");
		const u2 = parent.message("user", "U2");
		const sent = await lastRequest(parent);
		const fork = await forkOf(parent, captureOf(sent, u2.message as SimMessage));

		const first = await fork.request("fork reply 1");
		fork.message("toolResult", "tool result");
		const second = await fork.request("fork reply 2");
		expect(blocks(first)).toEqual(WHOLE);
		expect(blocks(second)).toEqual([...WHOLE, "assistant:fork reply 1", "user:tool result"]);
	});

	it("records the capture with the tail when the fork's ledger opens an epoch, so the next request extends both", async () => {
		const parent = new LedgerSim();
		await parent.sessionStart();
		parent.message("user", "U1");
		await parent.request("A1");
		const u2 = parent.message("user", "U2");
		const sent = await parent.request("A2");
		parent.add({ type: "custom", customType: RECORD.epoch, data: { v: 1, by: "test", cause: "fold" } });
		const fork = await forkOf(parent, captureOf(sent, u2.message as SimMessage));

		const first = await fork.request("fork reply 1");
		fork.message("toolResult", "tool result");
		const second = await fork.request("fork reply 2");
		expect(fork.plans.map((plan) => plan.cause)).toEqual(["fold", undefined]);
		const whole = ["user:U1", "assistant:A1", "user:U2", "assistant:A2", "user:btw Q", "assistant:btw A", "user:fork task"];
		expect(blocks(first)).toEqual(whole);
		expect(blocks(second)).toEqual([...whole, "assistant:fork reply 1", "user:tool result"]);
	});
	// pi-ai's strict-tools fallback renders the request again in the same call,
	// from the same cut context (only the fork's tail): that body needs the
	// capture as much as the first, and the record must match what went out.
	it("sends the capture again when pi-ai re-sends the fork's epoch request in the same call", async () => {
		const parent = new LedgerSim();
		await parent.sessionStart();
		parent.message("user", "U1");
		await parent.request("A1");
		const u2 = parent.message("user", "U2");
		const sent = await parent.request("A2");
		parent.add({ type: "custom", customType: RECORD.epoch, data: { v: 1, by: "test", cause: "fold" } });
		const fork = await forkOf(parent, captureOf(sent, u2.message as SimMessage));

		const inherited = fork.records("request").length;
		const first = await fork.request("fork reply 1", "stop", 2, 1000, (payload) => ({ ...payload, tools: [] }));
		const whole = ["user:U1", "assistant:A1", "user:U2", "assistant:A2", "user:btw Q", "assistant:btw A", "user:fork task"];
		expect(blocks(first)).toEqual(whole);
		// The re-send is the first body again: one record.
		expect(fork.records("request")).toHaveLength(inherited + 1);
		fork.message("toolResult", "tool result");
		const second = await fork.request("fork reply 2");
		expect(blocks(second)).toEqual([...whole, "assistant:fork reply 1", "user:tool result"]);
	});

	// The parent sent U1 before the value was registered and keeps sending it as
	// sent. A fork's epoch must not redact inside the capture: those bytes are
	// what the parent cached, and only the fork's own tail is new.
	it("leaves the captured prefix as the parent sent it when a secret value is registered later", async () => {
		const parent = new LedgerSim();
		await parent.sessionStart();
		parent.message("user", "U1 hunter2-token-xyz");
		await parent.request("A1");
		const u2 = parent.message("user", "U2");
		const sent = await parent.request("A2");
		parent.add({ type: "custom", customType: RECORD.epoch, data: { v: 1, by: "test", cause: "fold" } });
		const fork = await forkOf(parent, captureOf(sent, u2.message as SimMessage));
		setSecretValues("fork-cache-test", [{ value: "hunter2-token-xyz", name: "t" }]);
		try {
			const first = await fork.request("fork reply 1");
			expect(blocks(first)[0]).toBe("user:U1 hunter2-token-xyz");
		} finally {
			setSecretValues("fork-cache-test", []);
		}
	});
});
