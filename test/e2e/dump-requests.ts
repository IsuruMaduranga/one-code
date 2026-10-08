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
 * bytes untouched. For Codex, put transport: "sse" in a probe project's
 * .pi/settings.json and trust that fixture for the run with --approve (otherwise
 * pi ignores project settings). WebSocket continuation frames bypass fetch.
 *
 *   WIRE_DUMP=/tmp/wire.jsonl pi -e test/e2e/dump-requests.ts --mode json -p "…"
 *
 * One JSON line per request (a body with a `messages` or `input` array; token
 * counting is skipped). An SDK retry re-sends and so re-dumps — cache-probe.mjs
 * warns when the line count and the assistant usages disagree. Used 2026-09-04
 * to verify the sticky-append reminder placement (working-docs/decisions/tools.md,
 * "Three reminder placements") and 2026-09-21 for the deferred-tool stability
 * check (working-docs/decisions/caching.md).
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

export default function dump(_pi: ExtensionAPI) {
	const out = process.env.WIRE_DUMP ?? "/tmp/wire-dump.jsonl";
	// Keep the receiver: implementations are permitted to require globalThis.
	const original = globalThis.fetch.bind(globalThis);
	const wrapped: typeof fetch = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("count_tokens")) {
			try {
				const body = jsonRequestBody(init?.body, init?.headers);
				if (body === undefined) return original(input, init);
				const parsed = JSON.parse(body) as { messages?: unknown; input?: unknown };
				if (Array.isArray(parsed.messages) || Array.isArray(parsed.input)) appendFileSync(out, `${body}\n`);
			} catch {
				// not JSON — not a model request
			}
		}
		return original(input, init);
	};
	globalThis.fetch = wrapped;
}
