/**
 * The client's side of files changed on disk (tools/lsp/client.ts
 * `applyDiskChanges`, `refreshOpenFiles`): what a server receives when a
 * file it holds open, or one it never opened, changes outside the session's
 * edit tools. The server is a real child process (a few lines of node that
 * record every notification and hand them back on a request), so the bytes
 * on the pipe are what is checked.
 */
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient, pathToUri } from "../../extensions/tools/lsp/client.ts";

/** Answers `initialize` with what the client advertised, and `test/received` with the notifications since the last ask. */
const RECORDING_SERVER = `
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
		else if (message.method === "shutdown") send({ id: message.id, result: null });
		else if (message.method === "exit") process.exit(0);
		else if (message.id === undefined && message.method !== "initialized") received.push({ method: message.method, params: message.params });
	}
});
`;

interface Recorded {
	received: Array<{ method: string; params: { textDocument?: { uri: string; version?: number; text?: string }; contentChanges?: Array<{ text: string }>; changes?: Array<{ uri: string; type: number }> } }>;
	capabilities: { workspace?: { didChangeWatchedFiles?: unknown } };
}

describe("files changed on disk", () => {
	let dir: string;
	let client: LspClient;
	const received = async () => (await client.request("test/received", null)) as Recorded;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "lsp-disk-"));
		client = new LspClient({ command: process.execPath, args: ["-e", RECORDING_SERVER] }, dir);
		await client.start();
	});
	afterEach(async () => {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Write `text` and move the file's mtime, so a stat check sees it even within one clock tick. */
	const write = (path: string, text: string, secondsAhead = 0) => {
		writeFileSync(path, text);
		const when = new Date(Date.now() + secondsAhead * 1000);
		utimesSync(path, when, when);
	};

	it("advertises watched-file events without dynamic registration", async () => {
		// Dynamic registration would make a server leave file watching to this client, which watches nothing.
		expect((await received()).capabilities.workspace?.didChangeWatchedFiles).toEqual({ dynamicRegistration: false });
	});

	it("re-sends an open file from disk, and announces the others in one watched-files event", async () => {
		const open = join(dir, "open.src");
		const changed = join(dir, "changed.src");
		const created = join(dir, "created.src");
		const deleted = join(dir, "deleted.src");
		write(open, "one");
		client.syncFile(open, "src");
		write(open, "two", 5);
		write(changed, "x");
		write(created, "y");

		expect(client.applyDiskChanges([{ path: open }, { path: changed }, { path: created, type: "created" }, { path: deleted, type: "changed" }])).toEqual([pathToUri(open)]);
		const { received: sent } = await received();
		expect(sent.map((message) => message.method)).toEqual(["textDocument/didOpen", "textDocument/didChange", "workspace/didChangeWatchedFiles"]);
		expect(sent[1].params).toEqual({ textDocument: { uri: pathToUri(open), version: 2 }, contentChanges: [{ text: "two" }] });
		// The disk decides that a missing file is deleted, whatever the caller said.
		expect(sent[2].params.changes).toEqual([
			{ uri: pathToUri(changed), type: 2 },
			{ uri: pathToUri(created), type: 1 },
			{ uri: pathToUri(deleted), type: 3 },
		]);
	});

	it("closes a deleted open file and announces the deletion, and sends nothing for an unchanged one", async () => {
		const kept = join(dir, "kept.src");
		const gone = join(dir, "gone.src");
		write(kept, "same");
		write(gone, "soon gone");
		client.syncFile(kept, "src");
		client.syncFile(gone, "src");
		await received();
		unlinkSync(gone);

		expect(client.applyDiskChanges([{ path: kept }, { path: gone, type: "deleted" }])).toEqual([]);
		const { received: sent } = await received();
		expect(sent).toEqual([
			{ method: "textDocument/didClose", params: { textDocument: { uri: pathToUri(gone) } } },
			{ method: "workspace/didChangeWatchedFiles", params: { changes: [{ uri: pathToUri(gone), type: 3 }] } },
		]);

		// Closed: a file of that name written again is new to the server, and opens again on the next sync.
		write(gone, "back");
		client.syncFile(gone, "src");
		expect((await received()).received.map((message) => message.method)).toEqual(["textDocument/didOpen"]);
	});

	it("refreshes only the open files whose stat moved, skipping the one the caller syncs itself", async () => {
		const a = join(dir, "a.src");
		const b = join(dir, "b.src");
		const c = join(dir, "c.src");
		for (const path of [a, b, c]) {
			write(path, "v1");
			client.syncFile(path, "src");
		}
		await received();

		expect(client.refreshOpenFiles()).toEqual([]);
		write(a, "v2", 5);
		write(b, "v2", 5);
		// A touch with the same text sends nothing, and the new stat is kept, so the next refresh reads nothing.
		write(c, "v1", 5);
		unlinkSync(b);

		expect(client.refreshOpenFiles(b)).toEqual([pathToUri(a)]);
		const { received: sent } = await received();
		expect(sent.map((message) => [message.method, message.params.textDocument?.uri])).toEqual([["textDocument/didChange", pathToUri(a)]]);
		expect(client.refreshOpenFiles(b)).toEqual([]);
		expect((await received()).received).toEqual([]);
	});
});
