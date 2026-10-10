/** Bounded response decoding. Oversized or binary bodies are errors, never partial page content. */

/** Match Claude Code's 10 MiB response limit; pagination happens only after a complete download. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

const BINARY_TYPES = new Set([
	"application/pdf", "application/octet-stream", "application/zip", "application/gzip",
	"application/x-gzip", "application/x-tar", "application/x-7z-compressed", "application/vnd.rar",
]);

export async function readResponseText(response: Response, signal?: AbortSignal): Promise<string> {
	const contentType = response.headers.get("content-type") ?? "";
	const mime = contentType.split(";", 1)[0].trim().toLowerCase();
	// Application types also include text (YAML, GraphQL, vendor JSON, ...).
	// Reject known binary formats rather than treating every unfamiliar type as binary.
	if (BINARY_TYPES.has(mime) || (/^(?:image|audio|video|font)\//.test(mime) && !mime.endsWith("+xml"))) {
		throw new Error(`Unsupported binary content type ${mime}; use bash to download the file, then read it with a tool that supports that format`);
	}
	const charset = /\bcharset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? "utf-8";
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset);
	} catch {
		// A label the WHATWG decoder does not know (`utf8mb4`): read it as UTF-8, as before.
		decoder = new TextDecoder("utf-8");
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
	signal?.addEventListener("abort", onAbort, { once: true });
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_BODY_BYTES) throw new Error(`Response exceeds the ${MAX_BODY_BYTES / (1024 * 1024)} MiB download limit; use bash to download the file instead`);
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		signal?.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
