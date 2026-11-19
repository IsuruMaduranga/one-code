/**
 * The pi behavior subagents/stall-watch.ts stands behind, checked offline:
 * pi's stream watchdog. pi installs an idle timeout on every HTTP stream
 * (undici `bodyTimeout`, 300 s by default; pi-coding-agent http-dispatcher.js,
 * not exported, so the same undici setting is built here), and its auto-retry
 * re-sends a request whose reply ended in a retryable error
 * (`isRetryableAssistantError`). A stream that goes silent must therefore end
 * in an error pi retries, before the first event and after it, on the APIs
 * One Code's providers use. If a pi bump changes the error text or the rule,
 * a stalled stream would end the turn instead of retrying it.
 */
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { isRetryableAssistantError, streamSimple } from "@earendil-works/pi-ai/compat";

/** The undici pi's own dispatcher uses, resolved from pi-coding-agent (One Code declares none). */
const piPackage = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const { Agent, fetch: undiciFetch } = createRequire(piPackage)("undici") as typeof import("undici");
import { afterEach, describe, expect, it } from "vitest";

let server: Server | undefined;
afterEach(() => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
});

/** A server that answers with the stream's headers and `first` (if any), then says nothing more. */
async function stallingServer(first: string): Promise<string> {
	server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		// Node holds the headers until the first write; a real API sends them at once.
		response.flushHeaders();
		if (first) response.write(first);
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** fetch with pi's idle timeout, shortened. */
const idleTimeoutFetch = (ms: number) => {
	const dispatcher = new Agent({ bodyTimeout: ms });
	return ((url: string, init?: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
};

const base = { reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 100 };

const anthropicFirst =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const responsesFirst = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n';

const cases = [
	{ name: "Anthropic", api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5", apiKey: "sk-ant-test", first: anthropicFirst },
	{ name: "OpenAI Responses", api: "openai-responses", provider: "openai", id: "gpt-6.1-sol", apiKey: "sk-test", first: responsesFirst },
] as const;

describe("a stream that goes silent ends in an error pi's auto-retry re-sends", () => {
	for (const c of cases) {
		for (const when of ["before the first event", "after the first event"] as const) {
			it(`${c.name}, ${when}`, async () => {
				const baseUrl = await stallingServer(when === "after the first event" ? c.first : "");
				const model = { ...base, id: c.id, name: c.id, api: c.api, provider: c.provider, baseUrl };
				const events = streamSimple(model as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
					apiKey: c.apiKey,
					maxRetries: 0,
					fetch: idleTimeoutFetch(300),
				} as never);
				let final: { stopReason?: string; errorMessage?: string } | undefined;
				for await (const event of events as AsyncIterable<{ type: string; error?: typeof final; message?: typeof final }>) {
					if (event.type === "error") final = event.error;
					if (event.type === "done") final = event.message;
				}
				expect(final?.stopReason).toBe("error");
				expect(isRetryableAssistantError(final as never), final?.errorMessage).toBe(true);
			}, 10_000);
		}
	}
});
