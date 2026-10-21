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
 * A `/reload` re-runs this factory in the same process: the wrappers are
 * installed once per process, so a request is never dumped twice.
 */
import { appendFileSync } from "node:fs";
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

/** Marks an installed wrapper, so a `/reload` (a second factory run) does not wrap it again. */
const WRAPPED = Symbol.for("one-code.dump-requests");
type Marked = { [WRAPPED]?: { sessionRequest: boolean } };

export default function dump(pi: ExtensionAPI) {
	const out = process.env.WIRE_DUMP ?? "/tmp/wire-dump.jsonl";
	const meta = process.env.WIRE_DUMP_META;
	const installed = (globalThis.fetch as Marked)[WRAPPED];
	const state = installed ?? { sessionRequest: false };
	pi.on("before_provider_request", () => {
		state.sessionRequest = true;
	});
	if (installed) return;
	const write = (body: string) => {
		appendFileSync(out, `${body}\n`);
		if (meta) appendFileSync(meta, `${JSON.stringify({ session: state.sessionRequest, pid: process.pid })}\n`);
		state.sessionRequest = false;
	};
	// Keep the receiver: implementations are permitted to require globalThis.
	const original = globalThis.fetch.bind(globalThis);
	const wrapped: typeof fetch & Marked = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("count_tokens")) {
			try {
				const body = jsonRequestBody(init?.body, init?.headers);
				if (body === undefined) return original(input, init);
				const parsed = JSON.parse(body) as { messages?: unknown; input?: unknown };
				if (Array.isArray(parsed.messages) || Array.isArray(parsed.input)) write(body);
			} catch {
				// not JSON — not a model request
			}
		}
		return original(input, init);
	};
	wrapped[WRAPPED] = state;
	globalThis.fetch = wrapped;

	// pi-ai opens Codex sockets with Node's global WebSocket and sends each request as one JSON frame.
	const socket = (globalThis as { WebSocket?: { prototype: { send(data: unknown): void } } }).WebSocket;
	if (socket) {
		const send = socket.prototype.send;
		socket.prototype.send = function (this: unknown, data: unknown) {
			if (typeof data === "string") {
				try {
					const { type, ...body } = JSON.parse(data) as { type?: string; input?: unknown };
					if (type === "response.create" && Array.isArray(body.input)) write(JSON.stringify(body));
				} catch {
					// not JSON: not a model request
				}
			}
			return send.call(this, data);
		};
	}
}
