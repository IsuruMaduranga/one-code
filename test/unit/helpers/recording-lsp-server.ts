/**
 * A language server for tests, as a script for `node -e`. It answers `initialize` with what the client advertised, and `test/received`
 * with the notifications since the last ask. After each `didOpen` or
 * `didChange` it publishes one diagnostic carrying the document's text; it
 * publishes nothing on `didClose`, as a server that leaves a closed file's
 * diagnostics standing does. It refuses `test/refuse` with a JSON-RPC error
 * that carries `data`, the way a server reports an unknown method.
 *
 * `PID_FILE` in its environment makes it write its pid there. `STUBBORN=1`
 * makes it ignore `exit` and a closed stdin, as a JVM server behind a
 * launcher script does; `STUBBORN=launcher` also kills its parent on `exit`,
 * as a launcher that exits while the server it started lives on.
 * `SLOW_TERM=1` makes it ignore SIGTERM, as a server whose graceful shutdown
 * runs past the stop's grace.
 */
export const RECORDING_SERVER = `
if (process.env.PID_FILE) require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid));
if (process.env.STUBBORN) { setInterval(() => {}, 1000); process.stdin.on("error", () => {}); }
// The launcher, read once at start: a server whose launcher already died is adopted by
// another process (a subreaper, init), which the exit message must never signal.
const launcherPid = process.ppid;
if (process.env.SLOW_TERM) process.on("SIGTERM", () => {});
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
		else if (message.method === "exit") { if (process.env.STUBBORN === "launcher") { if (process.ppid === launcherPid) process.kill(launcherPid); } else if (!process.env.STUBBORN) process.exit(0); }
		else if (message.id === undefined && message.method !== "initialized") {
			received.push({ method: message.method, params: message.params });
			const text = message.params?.textDocument?.text ?? message.params?.contentChanges?.[0]?.text;
			if (text !== undefined) send({ method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: text }] } });
		}
	}
});
`;
