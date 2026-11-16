/**
 * Node preload that records every request made through `globalThis.fetch`:
 * host, path, status and the request body, one JSON line each, to the file
 * named by FETCH_CAPTURE. dump-requests.ts records model requests only (side
 * calls included: WIRE_DUMP_META marks them `session:false`), as bodies alone;
 * this preload also records the fetches that are not model calls (catalog and
 * update checks, web fetches), with each call's status, host and path, and
 * needs no extension: it loads in every Node process of the run.
 *
 *   FETCH_CAPTURE=/tmp/fetch.jsonl node --import ./test/e2e/capture-fetch.mjs <script>
 *   FETCH_CAPTURE=/tmp/fetch.jsonl NODE_OPTIONS="--import $PWD/test/e2e/capture-fetch.mjs" pi -p "..."
 *   node test/e2e/capture-fetch-summary.mjs /tmp/fetch.jsonl
 *
 * Absolute path in NODE_OPTIONS: the preload loads in every Node process the
 * run starts, and each appends to the same file. Each line is
 * `{ts, pid, method, host, path, status, bytes, body}`. `path` has no query
 * string (some APIs carry a key there). `status` is the response status, or
 * "error" when the call threw. `bytes` is the size of the body's text as sent
 * (decoded, for a zstd body). `body` is the parsed JSON, the text for a
 * non-JSON string, null when the call had no body, and `{"unreadable": kind}`
 * for a body that cannot be read without consuming it (a stream). A zstd body
 * (pi-ai compresses OpenAI Codex requests) is decoded for the record only.
 * Headers are never read into the record, so no key or token can reach the
 * file. The response body is never touched.
 *
 * pi replaces `globalThis.fetch` while it starts, so the preload installs a
 * property setter: whatever function is assigned later is wrapped on
 * assignment, and the function in place at preload time is wrapped too. A
 * wrapper that calls the previous (already wrapped) function records once:
 * only the outermost call is written. Not covered: code that imported its own
 * fetch (undici) before or without `globalThis.fetch`, and WebSockets.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const OUT = process.env.FETCH_CAPTURE;
const MARK = Symbol.for("one-code.capture-fetch");

/**
 * The part of a request's body worth recording, as `{ body, text }`: `body` is
 * the parsed JSON, the text, null or an `unreadable` note; `text` the body's
 * text as sent, when it could be read.
 */
function readBody(input, init) {
	const raw = init?.body;
	if (raw === undefined || raw === null) return { body: typeof input === "object" && input && "body" in input && input.body ? { unreadable: "request-object" } : null };
	let text;
	if (typeof raw === "string") text = raw;
	else if (raw instanceof URLSearchParams) text = raw.toString();
	else if (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
		const bytes = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
		const encoding = new Headers(init?.headers).get("content-encoding")?.toLowerCase();
		try {
			text = Buffer.from(encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8");
		} catch {
			return { body: { unreadable: "binary" } };
		}
	} else return { body: { unreadable: raw?.constructor?.name ?? typeof raw } };
	try {
		return { body: JSON.parse(text), text };
	} catch {
		return { body: text, text };
	}
}

/** The base a relative target parses against, so its query, fragment and userinfo drop out as an absolute one's do. */
const RELATIVE = "http://relative.invalid";

function target(input) {
	// A Request carries `url`; anything else fetch accepts is stringified, as fetch does.
	const href = typeof input === "string" ? input : (input?.url ?? String(input));
	// A relative URL makes the call itself fail; whatever still does not parse is never written raw.
	try {
		const url = new URL(href, RELATIVE);
		return { host: url.origin === RELATIVE ? "" : url.host, path: url.pathname };
	} catch {
		return { host: "", path: "(unparseable)" };
	}
}

const nested = new AsyncLocalStorage();

function wrap(fn) {
	if (typeof fn !== "function" || fn[MARK]) return fn;
	const wrapped = function (input, init) {
		if (nested.getStore()) return fn.call(this, input, init);
		const { host, path } = target(input);
		const method = (init?.method ?? (typeof input === "object" && input && "method" in input ? input.method : undefined) ?? "GET").toUpperCase();
		let body = null;
		let bytes = 0;
		try {
			const read = readBody(input, init);
			body = read.body;
			bytes = read.text === undefined ? 0 : Buffer.byteLength(read.text);
		} catch {
			body = { unreadable: "error" };
		}
		const write = (status) => {
			try {
				appendFileSync(OUT, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, method, host, path, status, bytes, body })}\n`);
			} catch {
				// A capture that cannot write must not break the run it observes.
			}
		};
		let call;
		try {
			call = nested.run(true, () => fn.call(this, input, init));
		} catch (error) {
			write("error");
			throw error;
		}
		return call.then(
			(response) => {
				write(response.status);
				return response;
			},
			(error) => {
				write("error");
				throw error;
			},
		);
	};
	Object.defineProperty(wrapped, MARK, { value: true });
	return wrapped;
}

if (OUT && !globalThis.fetch?.[MARK] && !Object.getOwnPropertyDescriptor(globalThis, "fetch")?.get) {
	let current = wrap(globalThis.fetch);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		enumerable: true,
		get: () => current,
		set: (fn) => {
			current = wrap(fn);
		},
	});
}
