import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** `--import` takes a URL: a bare Windows path reads as a `d:` scheme. */
const preload = pathToFileURL(join(import.meta.dirname, "../e2e/capture-fetch.mjs")).href;
const summary = join(import.meta.dirname, "../e2e/capture-fetch-summary.mjs");

// The scenario runs in a child Node with the preload, against a local server:
// no network and no model.
const scenario = `
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
const server = createServer((req, res) => {
	req.resume();
	req.on("end", () => { res.statusCode = req.url.startsWith("/missing") ? 404 : 200; res.end("{}"); });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const key = "SECRET-KEY-VALUE";
// A request made through the function in place when the preload ran.
await fetch(base + "/v1/messages?key=" + key, {
	method: "POST",
	headers: { authorization: "Bearer " + key, "x-api-key": key, "content-type": "application/json" },
	body: JSON.stringify({ model: "m-1", cache_control: { type: "ephemeral" }, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [] }),
});
// pi installs its own fetch at startup: a replacement that wraps the previous one.
const previous = globalThis.fetch;
globalThis.fetch = (input, init) => previous(input, init);
await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m-2", prompt_cache_key: "abcdefghijklmnopqrstuvwxyz", prompt_cache_retention: "24h", input: [] }, null, 2) });
// A replacement that does not call the previous one (the golden fixture's shape).
globalThis.fetch = async () => new Response("{}", { status: 503 });
await fetch("https://example.invalid/catalog", { headers: { authorization: "Bearer " + key } });
// An unreadable body, a zstd body, a failure and a missing path.
globalThis.fetch = (input, init) => previous(input, init);
await fetch(base + "/stream", { method: "POST", body: new ReadableStream({ start(c) { c.close(); } }), duplex: "half" }).catch(() => {});
await fetch(base + "/codex", { method: "POST", headers: { "content-encoding": "zstd" }, body: zstdCompressSync(Buffer.from(JSON.stringify({ model: "m-3", input: [] }))) });
await fetch(base + "/missing");
globalThis.fetch = () => Promise.reject(new Error("offline"));
await fetch("https://example.invalid/down", { method: "POST", body: "plain text" }).catch(() => {});
server.close();
`;

describe("capture-fetch preload and summary", () => {
	let dir: string;
	let out: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "capture-fetch-"));
		out = join(dir, "fetch.jsonl");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = () => {
		const script = join(dir, "scenario.mjs");
		writeFileSync(script, scenario);
		execFileSync(process.execPath, ["--import", preload, script], { env: { ...process.env, FETCH_CAPTURE: out }, stdio: "pipe" });
		return readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	};

	it("records host, path, status and body once per call, wrapping fetch on assignment, and never a header or key", () => {
		const rows = run();
		expect(rows.map((r) => [r.host.startsWith("127.0.0.1:") ? "local" : r.host, r.path, r.status])).toEqual([
			["local", "/v1/messages", 200],
			["local", "/v1/chat/completions", 200],
			["example.invalid", "/catalog", 503],
			["local", "/stream", 200],
			["local", "/codex", 200],
			["local", "/missing", 404],
			["example.invalid", "/down", "error"],
		]);
		expect(rows[0].body).toMatchObject({ model: "m-1", messages: [] });
		// The size of the body as sent, not of the record's re-serialized copy.
		expect(rows[0].bytes).toBe(Buffer.byteLength(JSON.stringify({ model: "m-1", cache_control: { type: "ephemeral" }, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [] })));
		// A pretty-printed body: its size is its own, larger than the record's compact copy.
		expect(rows[1].bytes).toBe(Buffer.byteLength(JSON.stringify({ model: "m-2", prompt_cache_key: "abcdefghijklmnopqrstuvwxyz", prompt_cache_retention: "24h", input: [] }, null, 2)));
		expect(rows[3].bytes).toBe(0);
		expect(rows[3].body).toEqual({ unreadable: "ReadableStream" });
		expect(rows[4].body).toEqual({ model: "m-3", input: [] });
		expect(rows[5].body).toBeNull();
		expect(rows[6].body).toBe("plain text");
		const text = readFileSync(out, "utf8");
		expect(text).not.toContain("SECRET-KEY-VALUE");
		expect(text).not.toMatch(/authorization|x-api-key/i);
	});

	it("keeps the query and userinfo out of a relative target", () => {
		writeFileSync(join(dir, "relative.mjs"), "await fetch('/v1/messages?key=SECRET-KEY-VALUE#frag').catch(() => {}); await fetch('//user:SECRET-KEY-VALUE@gw.example/p').catch(() => {});");
		execFileSync(process.execPath, ["--import", preload, join(dir, "relative.mjs")], { env: { ...process.env, FETCH_CAPTURE: out }, stdio: "pipe" });
		const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.map((r) => [r.host, r.path, r.status])).toEqual([
			["", "/v1/messages", "error"],
			["gw.example", "/p", "error"],
		]);
		expect(readFileSync(out, "utf8")).not.toContain("SECRET-KEY-VALUE");
	});

	it("does nothing without FETCH_CAPTURE", () => {
		writeFileSync(join(dir, "plain.mjs"), "const original = globalThis.fetch; await original('http://127.0.0.1:1/').catch(() => {}); console.log(typeof Object.getOwnPropertyDescriptor(globalThis, 'fetch').get);");
		const printed = execFileSync(process.execPath, ["--import", preload, join(dir, "plain.mjs")], { env: { ...process.env, FETCH_CAPTURE: "" }, stdio: "pipe" }).toString().trim();
		expect(printed).toBe("undefined");
	});

	it("prints one line per request with model, size and cache fields", () => {
		run();
		const lines = execFileSync(process.execPath, [summary, out]).toString().trim().split("\n");
		expect(lines).toHaveLength(7);
		expect(lines[0]).toMatch(/POST 127\.0\.0\.1:\d+\/v1\/messages {2}200 {2}model=m-1 {2}\d+ B {2}cache cc=2\+top$/);
		expect(lines[1]).toMatch(/\/v1\/chat\/completions {2}200 {2}model=m-2 .* cache key=abcdefghijkl ret=24h$/);
		expect(lines[2]).toMatch(/GET example\.invalid\/catalog {2}503 {2}model=- {2}0 B {2}cache -$/);
		expect(lines[6]).toMatch(/\/down {2}error /);
	});

	// Guards only where Node writes stdout to a pipe asynchronously (macOS): on Linux and Windows the
	// write is synchronous, so the old `process.exit` passed there too. CI runs it on macOS.
	it("prints every row to a reader slower than the pipe before it exits", async () => {
		const row = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", method: "POST", host: "h", path: "/p", status: 200, bytes: 1, body: { model: "m" } });
		writeFileSync(out, `${row}\n`.repeat(5000));
		const child = spawn(process.execPath, [summary, out], { stdio: ["ignore", "pipe", "ignore"] });
		const closed = once(child, "close");
		// Not reading yet: the pipe fills and the rest of the output waits in the child.
		child.stdout.pause();
		await new Promise((resolve) => setTimeout(resolve, 300));
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stdout.resume();
		const [code] = await closed;
		expect(code).toBe(0);
		expect(Buffer.concat(chunks).toString().trim().split("\n")).toHaveLength(5000);
	});

	it("exits with status 2 without a file and 1 for one it cannot read", () => {
		const statusOf = (args: string[]) => {
			try {
				execFileSync(process.execPath, [summary, ...args], { stdio: "pipe" });
				return 0;
			} catch (error) {
				return (error as { status: number }).status;
			}
		};
		expect(statusOf([])).toBe(2);
		expect(statusOf([join(dir, "nope.jsonl")])).toBe(1);
	});
});
