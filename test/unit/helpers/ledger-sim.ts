/**
 * A session the ledger runs in, for tests of the request path end to end
 * without pi: the real ledger and ledger-wire extensions on a fake pi, a
 * session file as an entry list, pi's context pass and payload hooks, and a
 * stand-in renderer that delivers every pending item onto the tail's last
 * message (the real one is system-reminder). `load()` again is a `/reload`:
 * new instances on the same entries.
 */
import ledgerExtension from "../../../extensions/ledger/index.ts";
import ledgerWireExtension from "../../../extensions/ledger/wire.ts";
import { foldBranch } from "../../../extensions/lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../../../extensions/lib/ledger/plan.ts";
import { type EntryLike, makeRecord, RECORD, readRecord } from "../../../extensions/lib/ledger/records.ts";

export interface SimMessage {
	role: string;
	text: string;
	timestamp: number;
	stopReason?: string;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Payload = { model: string; max_tokens: number; system: string; tools: { name: string }[]; messages: { role: string; content: { type: string; text: string }[] }[] };

export class LedgerSim {
	entries: (EntryLike & { message?: SimMessage })[] = [];
	model: { api: string; provider: string; id: string; baseUrl?: string } = { api: "anthropic-messages", provider: "acme", id: "m1" };
	/** The session id: a /fork copies the entries under a new one. */
	sessionId = "s1";
	tools: { name: string }[] = [{ name: "read" }];
	sent: Payload[] = [];
	/** The tail pi rendered for the last request: what a cache warm replays. */
	lastTail: SimMessage[] = [];
	plans: RequestPlan[] = [];
	private handlers: Record<string, Handler[]> = {};
	private listeners: Record<string, ((data: unknown) => void)[]> = {};
	private clock = 1000;

	constructor() {
		this.load();
	}

	/** New extension instances on the same session: a `/reload`. */
	load(): void {
		this.handlers = {};
		this.listeners = {};
		const pi = {
			on: (event: string, handler: Handler) => {
				(this.handlers[event] ??= []).push(handler);
			},
			events: {
				emit: (channel: string, data: unknown) => {
					for (const listener of this.listeners[channel] ?? []) listener(data);
				},
				on: (channel: string, listener: (data: unknown) => void) => {
					(this.listeners[channel] ??= []).push(listener);
				},
			},
			appendEntry: (customType: string, data: unknown) => this.add({ type: "custom", customType, data }),
		};
		ledgerExtension(pi as never);
		let plan: RequestPlan | undefined;
		pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
			plan = data as RequestPlan;
			this.plans.push(plan);
		});
		pi.on("context", (event) => {
			const current = plan;
			plan = undefined;
			const items = current?.fold.pending ?? [];
			if (!current || items.length === 0) return undefined;
			const messages = [...(event as { messages: SimMessage[] }).messages];
			const last = messages.at(-1);
			if (!last) return undefined;
			messages[messages.length - 1] = { ...last, text: last.text + items.map((item) => ` <rem ${item.text}>`).join("") };
			current.consumed.push(...items.map((item) => item.id));
			return { messages };
		});
		ledgerWireExtension(pi as never);
	}

	ctx() {
		return { model: this.model, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => this.entries, getSessionId: () => this.sessionId } };
	}

	add(entry: Omit<EntryLike, "id" | "parentId"> & { message?: SimMessage }) {
		const full = { ...entry, id: `e${this.entries.length + 1}`, parentId: this.entries.at(-1)?.id ?? null };
		this.entries.push(full);
		return full;
	}

	message(role: string, text: string, stopReason?: string) {
		return this.add({ type: "message", message: { role, text, timestamp: ++this.clock, ...(stopReason ? { stopReason } : {}) } });
	}

	pending(text: string): void {
		this.add({ type: "custom", customType: RECORD.pending, data: makeRecord("pending", "test", { id: `p-${text}`, text }) });
	}

	/** pi omitting an entry from the model's view (a recovered length stop, a failed attempt before a retry). */
	omit(entryId: string): void {
		this.add({ type: "context_edit", targetId: entryId, replacement: null });
	}

	/** The messages pi would build: the branch's messages, without omitted ones. */
	projection(): SimMessage[] {
		const omitted = new Set(this.entries.filter((entry) => entry.type === "context_edit" && entry.replacement === null).map((entry) => entry.targetId));
		return this.entries.filter((entry) => entry.type === "message" && !omitted.has(entry.id)).map((entry) => entry.message as SimMessage);
	}

	render(tail: SimMessage[], cap = 1000): Payload {
		const sent = tail.filter((m) => !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")));
		return { model: this.model.id, max_tokens: cap, system: "S", tools: this.tools.map((tool) => ({ ...tool })), messages: sent.map((m) => ({ role: m.role === "toolResult" ? "user" : m.role, content: [{ type: "text", text: m.text }] })) };
	}

	async sessionStart(reason = "startup"): Promise<void> {
		for (const handler of this.handlers.session_start ?? []) await handler({ reason }, this.ctx());
	}

	async context(): Promise<SimMessage[]> {
		let out = this.projection();
		for (const handler of this.handlers.context ?? []) {
			const result = (await handler({ type: "context", messages: out }, this.ctx())) as { messages?: SimMessage[] } | undefined;
			if (result?.messages) out = result.messages;
		}
		return out;
	}

	async payload(tail: SimMessage[], cap = 1000, rendered: (payload: Payload) => Payload = (payload) => payload): Promise<Payload> {
		let payload = rendered(this.render(tail, cap));
		for (const handler of this.handlers.before_provider_request ?? []) {
			const result = await handler({ payload }, this.ctx());
			if (result !== undefined) payload = result as Payload;
		}
		return payload;
	}

	/**
	 * One request and its reply: one provider call, which resolves its headers
	 * once (pi's `prepareRequest`) before its payloads. `sends` > 1: pi-ai
	 * sending the body again in the same call (its strict-tools fallback);
	 * `resend` changes the body pi-ai renders for each later send. `cap`: the
	 * output cap pi-ai clamped the request to.
	 */
	async request(reply: string, stopReason = "stop", sends = 1, cap = 1000, resend?: (payload: Payload) => Payload): Promise<Payload> {
		const tail = await this.context();
		this.lastTail = tail;
		await this.headers();
		let payload = await this.payload(tail, cap);
		for (let i = 1; i < sends; i++) payload = await this.payload(tail, cap, resend);
		this.sent.push(payload);
		const entry = this.message("assistant", reply, stopReason);
		for (const handler of this.handlers.message_end ?? []) await handler({ message: entry.message }, this.ctx());
		return payload;
	}

	/** A request that went out and got no reply (the process died mid-stream). */
	async requestWithoutReply(): Promise<Payload> {
		const tail = await this.context();
		this.lastTail = tail;
		await this.headers();
		const payload = await this.payload(tail);
		this.sent.push(payload);
		return payload;
	}

	/** The headers pi-ai would send, after the extensions' header hooks. */
	async headers(): Promise<Record<string, string>> {
		const event = { headers: {} as Record<string, string> };
		for (const handler of this.handlers.before_provider_headers ?? []) await handler(event, this.ctx());
		return event.headers;
	}

	/** pi's cache warm: its own provider call, the last request's context through the payload hooks again, with the cap at 1. */
	async warm(): Promise<Payload> {
		await this.headers();
		const payload = await this.payload(this.lastTail, 1);
		this.add({ type: "usage" });
		return payload;
	}

	records(kind?: string) {
		return this.entries.map((entry) => readRecord(entry)).filter((record) => record && (!kind || record.kind === kind));
	}

	fold() {
		return foldBranch(this.entries, { api: this.model.api, provider: this.model.provider, model: this.model.id, auth: "key" });
	}

	static texts(payload: Payload): string[] {
		return payload.messages.map((m) => `${m.role}:${m.content[0]?.text}`);
	}
}
