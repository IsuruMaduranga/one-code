/**
 * Node preload that records every request made through `globalThis.fetch`:
 * host, path, status and the request body, one JSON line each, to the file
 * named by FETCH_CAPTURE. It sees what dump-requests.ts cannot, the side calls
 * (classifier, reader, recap, title, catalog and update fetches), because it
 * hooks fetch for the whole process instead of one extension's view of it.
 *
 *   FETCH_CAPTURE=/tmp/fetch.jsonl node --import ./test/e2e/capture-fetch.mjs <script>
 *   FETCH_CAPTURE=/tmp/fetch.jsonl NODE_OPTIONS="--import $PWD/test/e2e/capture-fetch.mjs" pi -p "..."
 *   node test/e2e/capture-fetch-summary.mjs /tmp/fetch.jsonl
 *
 * Absolute path in NODE_OPTIONS: the preload loads in every Node process the
 * run starts, and each appends to the same file. Each line is
 * `{ts, pid, method, host, path, status, bytes, body}`. `path` has no query
 * string (some APIs carry a key there). `status` is the response status, or
 * "error" when the call threw. `body` is the parsed JSON, the text for a
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

/** The part of a request's body worth recording, as parsed JSON, text, null or an `unreadable` note. */
function readBody(input, init) {
	const raw = init?.body;
	if (raw === undefined || raw === null) return typeof input === "object" && input && "body" in input && input.body ? { unreadable: "request-object" } : null;
	let text;
	if (typeof raw === "string") text = raw;
	else if (raw instanceof URLSearchParams) text = raw.toString();
	else if (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
		const bytes = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
		const encoding = new Headers(init?.headers).get("content-encoding")?.toLowerCase();
		try {
			text = Buffer.from(encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8");
		} catch {
			return { unreadable: "binary" };
		}
	} else return { unreadable: raw?.constructor?.name ?? typeof raw };
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function target(input) {
	try {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return { host: url.host, path: url.pathname };
	} catch {
		return { host: "", path: String(input) };
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
			body = readBody(input, init);
			bytes = body === null ? 0 : Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body));
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
