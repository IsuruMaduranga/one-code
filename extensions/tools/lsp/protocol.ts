/**
 * LSP base protocol framing (pure).
 *
 * Messages are `Content-Length: <n>\r\n\r\n<n bytes of JSON>`. One chunk from a
 * server's stdout may contain several messages, or half of one, so the reader
 * keeps a buffer across calls.
 */

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

export function encodeMessage(message: Record<string, unknown>): Buffer {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf-8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export interface ReaderState {
	buffer: Buffer;
}

export function createReaderState(): ReaderState {
	return { buffer: Buffer.alloc(0) };
}

/**
 * Appends a chunk and returns every complete message now available. Malformed
 * headers are skipped rather than throwing, so one bad frame cannot wedge the
 * stream.
 */
export function readMessages(state: ReaderState, chunk: Buffer): JsonRpcMessage[] {
	state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
	const messages: JsonRpcMessage[] = [];

	while (true) {
		const headerEnd = state.buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return messages;

		const header = state.buffer.subarray(0, headerEnd).toString("ascii");
		const match = header.match(/content-length:\s*(\d+)/i);
		if (!match) {
			// Unparseable header: drop it and resynchronise.
			state.buffer = state.buffer.subarray(headerEnd + 4);
			continue;
		}

		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (state.buffer.length < bodyStart + length) return messages;

		const body = state.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
		state.buffer = state.buffer.subarray(bodyStart + length);
		try {
			messages.push(JSON.parse(body) as JsonRpcMessage);
		} catch {
			// Ignore a body that isn't JSON; the stream stays aligned.
		}
	}
}
