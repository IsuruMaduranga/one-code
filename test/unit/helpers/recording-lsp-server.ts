/**
 * A language server for tests, as a script for `node -e`. It answers `initialize` with what the client advertised, and `test/received`
 * with the notifications since the last ask. After each `didOpen` or
 * `didChange` it publishes one diagnostic carrying the document's text; it
 * publishes nothing on `didClose`, as a server that leaves a closed file's
 * diagnostics standing does. It refuses `test/refuse` with a JSON-RPC error
 * that carries `data`, the way a server reports an unknown method.
 */
export const RECORDING_SERVER = `
let buffer = Buffer.alloc(0);
let received = [];
let init;
const send = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
	process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
};
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\\r\\n\\r\\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		if (message.method === "initialize") { init = message.params; send({ id: message.id, result: { capabilities: {} } }); }
		else if (message.method === "test/received") { send({ id: message.id, result: { received, capabilities: init.capabilities } }); received = []; }
		else if (message.method === "test/refuse") send({ id: message.id, error: { code: -32601, message: "Internal error.", data: { detail: "Unsupported request: test/refuse" } } });
		else if (message.method === "shutdown") send({ id: message.id, result: null });
		else if (message.method === "exit") process.exit(0);
		else if (message.id === undefined && message.method !== "initialized") {
			received.push({ method: message.method, params: message.params });
			const text = message.params?.textDocument?.text ?? message.params?.contentChanges?.[0]?.text;
			if (text !== undefined) send({ method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: text }] } });
		}
	}
});
`;
