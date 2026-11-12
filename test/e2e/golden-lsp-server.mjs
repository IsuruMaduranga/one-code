#!/usr/bin/env node
/**
 * The golden snapshot's language server: golden-requests.mjs puts it on the
 * tools scenario's PATH as `gopls`, and golden-fixture.ts LSP_ROUNDS writes
 * and checks Go files. LSP's Content-Length framing over stdio, no library.
 * Every synced file is answered with a fixed publish: none when its text says
 * `clean`, else an error with a code and a source, and a warning.
 */

const diagnosticsFor = (text) =>
	text.includes("clean")
		? []
		: [
				{ range: { start: { line: 2, character: 1 }, end: { line: 2, character: 7 } }, severity: 1, code: "E1", source: "golden", message: "undefined: golden" },
				{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }, severity: 2, message: "unused value" },
			];

const send = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
};

const publish = (uri, text) => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsFor(text) } });

function handle(message) {
	const { id, method, params } = message;
	switch (method) {
		case "initialize":
			return send({ id, result: { capabilities: { textDocumentSync: 1 }, serverInfo: { name: "golden-lsp" } } });
		case "shutdown":
			return send({ id, result: null });
		case "exit":
			return process.exit(0);
		case "textDocument/didOpen":
			return publish(params.textDocument.uri, params.textDocument.text);
		case "textDocument/didChange":
			return publish(params.textDocument.uri, params.contentChanges.at(-1).text);
		default:
			if (id !== undefined && method) send({ id, result: null });
	}
}

let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffered = Buffer.concat([buffered, chunk]);
	for (;;) {
		const headerEnd = buffered.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffered.subarray(0, headerEnd).toString("ascii"))?.[1]);
		if (buffered.length < headerEnd + 4 + length) return;
		handle(JSON.parse(buffered.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")));
		buffered = buffered.subarray(headerEnd + 4 + length);
	}
});
