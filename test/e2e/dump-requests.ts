/**
 * Wire probe: dump every provider request body exactly as the provider receives
 * it. debug-capture.ts records requests before this package's mutations
 * (findings §8), and a `before_provider_request` hook in a `-e` extension runs
 * BEFORE the package's own (so it would miss what tool-search does to `tools`
 * and `messages`); this one wraps `globalThis.fetch` instead, which the
 * provider SDKs pick up when they build their client for each call, so the line
 * is the final JSON body — where each <system-reminder> block landed, the
 * `defer_loading` definitions, tool schemas, message order. Codex SSE requests
 * are zstd-compressed by pi-ai: decode a copy for the dump, send the original
 * bytes untouched. Codex's default WebSocket transport bypasses fetch, so
 * `WebSocket.prototype.send` is wrapped too: each `response.create` frame is
 * dumped without its `type` field. A continuation frame carries
 * `previous_response_id` and only the new input items, so a WebSocket line is
 * the delta the server received, not the whole conversation (put transport:
 * "sse" in a trusted probe project's .pi/settings.json for full bodies).
 *
 *   WIRE_DUMP=/tmp/wire.jsonl pi -e test/e2e/dump-requests.ts --mode json -p "…"
 *
 * One JSON line per request (a body with a `messages` or `input` array; token
 * counting is skipped). An SDK retry re-sends and so re-dumps — cache-probe.mjs
 * warns when the line count and the assistant usages disagree. Used 2026-09-04
 * to verify the sticky-append reminder placement (working-docs/decisions/tools.md,
 * "Three reminder placements") and 2026-09-21 for the deferred-tool stability
 * check (working-docs/decisions/caching.md).
 *
 * With WIRE_DUMP_META set, every dumped line also gets one line in that file,
 * `{"session":bool,"pid":n}`: `session` is true when the request went through
 * the session's own `before_provider_request` hooks (the main loop and pi's
 * cache warm), false for side calls made with completeSimple (compaction's
 * summarizer, recap, btw, the classifier). transition-probe uses it.
 * With WIRE_AUTH_DUMP set, every request sent through fetch also gets one line
 * there, `{"model":…,"bearer":bool,"apiKey":bool}`: whether it carried an
 * `Authorization: Bearer` header and an `x-api-key` header. Never a header's
 * value. cache-probe-auth.mjs reads it to show which credential a probe used.
 * With WIRE_RESPONSE_DUMP set, every dumped request also gets one line there
 * when its response ends, `{"dump":file,"line":n,"pid":n,"status":…,"headers":…,"type":…,"usage":…,"error":…}`:
 * `line` is the request's 1-based line in the WIRE_DUMP file, `headers` the
 * response's `x-*` and `cf-ray` headers (none on a WebSocket frame; an opaque
 * token is cut to its length), `type` the event that ended the response
 * (`response.completed`, `.failed`, `.incomplete` or `error`), with its usage and error.
 * On Codex that usage carries cache writes by TTL and an `attribution` map with
 * every input item's input and cached tokens: the evidence a cache miss needs
 * (findings §90, "Main-session misses, 2026-11-25").
 * A `/reload` re-runs this factory in the same process: the wrappers are
 * installed once per process, so a request is never dumped twice.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function jsonRequestBody(raw: unknown, headers: RequestInit["headers"] | undefined): string | undefined {
	if (typeof raw === "string") return raw;
	// Extensions run in a separate VM context. The provider's Uint8Array is not
	// an instanceof this context's Uint8Array, but ArrayBuffer.isView works
	// across realms (and includes Node's Buffer).
	if (new Headers(headers).get("content-encoding")?.toLowerCase() !== "zstd" || !ArrayBuffer.isView(raw)) return undefined;
	const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	return zstdDecompressSync(bytes).toString("utf8");
}

/** A Responses API event that ends a response. */
const TERMINAL = /"type"\s*:\s*"(response\.(completed|failed|incomplete)|error)"/;

/** Marks an installed wrapper, so a `/reload` (a second factory run) does not wrap it again. */
const WRAPPED = Symbol.for("one-code.dump-requests");
type Marked = { [WRAPPED]?: { sessionRequest: boolean } };

export default function dump(pi: ExtensionAPI) {
	const out = process.env.WIRE_DUMP ?? "/tmp/wire-dump.jsonl";
	const meta = process.env.WIRE_DUMP_META;
	const auth = process.env.WIRE_AUTH_DUMP;
	const responses = process.env.WIRE_RESPONSE_DUMP;
	const installed = (globalThis.fetch as Marked)[WRAPPED];
	const state = installed ?? { sessionRequest: false };
	pi.on("before_provider_request", () => {
		state.sessionRequest = true;
	});
	if (installed) return;
	// Line numbers continue an existing dump file; `pid` tells processes sharing it apart.
	let lines = existsSync(out) ? readFileSync(out, "utf8").split("\n").length - 1 : 0;
	/** Appends the request body; returns its line number in the dump. */
	const write = (body: string) => {
		appendFileSync(out, `${body}\n`);
		if (meta) appendFileSync(meta, `${JSON.stringify({ session: state.sessionRequest, pid: process.pid })}\n`);
		state.sessionRequest = false;
		return ++lines;
	};
	/**
	 * `text` is a whole SSE stream or one WebSocket frame; `res` is absent on a
	 * socket. Records the terminal event: its type, usage and any error.
	 */
	const writeResponse = (line: number, text: string, res?: Response) => {
		if (!responses) return;
		const last = text.split("\n").find((l) => TERMINAL.test(l));
		let event: { type?: string; response?: { usage?: unknown; error?: unknown }; error?: unknown } | undefined;
		try {
			event = last ? JSON.parse(last.replace(/^data: ?/, "")) : undefined;
		} catch {
			// a cut-off stream: keep the headers
		}
		const record = { dump: out, line, pid: process.pid, status: res?.status, headers: res && responseHeaders(res), type: event?.type, usage: event?.response?.usage, error: event?.response?.error ?? event?.error };
		try {
			appendFileSync(responses, `${JSON.stringify(record)}\n`);
		} catch {
			// evidence only: never fail the run under test
		}
	};
	/**
	 * `res` with its body passed through a recorder, so a provider's cancel still
	 * reaches the connection. `url`, `redirected` and `type` are not carried over.
	 */
	const recordResponse = (line: number, res: Response) => {
		if (!res.body) {
			writeResponse(line, "", res);
			return res;
		}
		const decoder = new TextDecoder();
		let text = "";
		const body = res.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					text += decoder.decode(chunk, { stream: true });
					controller.enqueue(chunk);
				},
				flush: () => writeResponse(line, text + decoder.decode(), res),
				// pi-ai's Codex reader cancels right after response.completed, before the stream ends.
				cancel: () => writeResponse(line, text, res),
			}),
		);
		return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
	};
	const responseHeaders = (res: Response) =>
		Object.fromEntries(
			[...res.headers]
				.filter(([k]) => k.startsWith("x-") || k === "cf-ray")
				.map(([k, v]) => [k, v.length > 80 ? `<${v.length} chars>` : v]),
		);
	// Keep the receiver: implementations are permitted to require globalThis.
	const original = globalThis.fetch.bind(globalThis);
	const wrapped: typeof fetch & Marked = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		let line: number | undefined;
		if (!url.includes("count_tokens")) {
			try {
				const body = jsonRequestBody(init?.body, init?.headers);
				if (body === undefined) return original(input, init);
				const parsed = JSON.parse(body) as { messages?: unknown; input?: unknown; model?: unknown };
				if (Array.isArray(parsed.messages) || Array.isArray(parsed.input)) {
					line = write(body);
					if (auth) {
						const headers = new Headers(init?.headers);
						const bearer = headers.get("authorization")?.startsWith("Bearer ") === true;
						appendFileSync(auth, `${JSON.stringify({ model: parsed.model, bearer, apiKey: headers.has("x-api-key") })}\n`);
					}
				}
			} catch {
				// not JSON — not a model request
			}
		}
		const sent = original(input, init);
		return responses && line !== undefined ? sent.then(recordResponse.bind(undefined, line)) : sent;
	};
	wrapped[WRAPPED] = state;
	globalThis.fetch = wrapped;

	// pi-ai opens Codex sockets with Node's global WebSocket and sends each request as one JSON frame.
	// A socket carries one response at a time, so a terminal frame answers its last dumped request.
	type Socket = { send(data: unknown): void; addEventListener(type: string, fn: (event: { data: unknown }) => void): void };
	const socket = (globalThis as { WebSocket?: { prototype: Socket } }).WebSocket;
	const lastLine = new WeakMap<Socket, number>();
	if (socket) {
		const send = socket.prototype.send;
		socket.prototype.send = function (this: Socket, data: unknown) {
			if (typeof data === "string") {
				try {
					const { type, ...body } = JSON.parse(data) as { type?: string; input?: unknown };
					if (type === "response.create" && Array.isArray(body.input)) {
						const line = write(JSON.stringify(body));
						if (responses && !lastLine.has(this)) {
							this.addEventListener("message", (event) => {
								const at = lastLine.get(this);
								if (typeof event.data === "string" && at !== undefined && TERMINAL.test(event.data)) writeResponse(at, event.data);
							});
						}
						lastLine.set(this, line);
					}
				} catch {
					// not JSON: not a model request
				}
			}
			return send.call(this, data);
		};
	}
}
