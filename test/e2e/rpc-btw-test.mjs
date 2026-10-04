#!/usr/bin/env node
/** /btw must answer an RPC client without entering the main conversation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const child = spawn("perl", ["-e", "alarm 180; exec @ARGV", "pi", "--mode", "rpc", "--no-session", "--no-extensions", "-e", resolve(root, "extensions/btw/index.ts"), "--model", process.argv[2] ?? "anthropic/claude-haiku-4-5"], {
	cwd: root,
	stdio: ["pipe", "pipe", "inherit"],
});
let nextId = 0;
const pending = new Map();
const notices = [];
const request = (type, args = {}) => new Promise((resolve, reject) => {
	const id = `btw-${++nextId}`;
	pending.set(id, { resolve, reject });
	child.stdin.write(`${JSON.stringify({ type, id, ...args })}\n`);
});
createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try { event = JSON.parse(line); } catch { return; }
	if (event.type === "extension_ui_request" && event.method === "notify") {
		notices.push(event.message);
		console.log(`NOTICE: ${event.message}`);
	} else if (event.type === "response") {
		const waiter = pending.get(event.id);
		if (!waiter) return;
		pending.delete(event.id);
		if (event.success) waiter.resolve(event.data);
		else waiter.reject(new Error(event.error));
	}
});
child.on("exit", (code) => {
	for (const waiter of pending.values()) waiter.reject(new Error(`pi exited: ${code}`));
	pending.clear();
});
const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	child.kill("SIGKILL");
	process.exitCode = 1;
}, 180_000);
try {
	await request("get_state");
	await request("prompt", { message: "/btw Reply with exactly RPC_SIDE_OK and nothing else." });
	assert.ok(notices.some((text) => text.trim() === "RPC_SIDE_OK"), "RPC client did not receive the side answer");
	assert.deepEqual((await request("get_messages")).messages, [], "Side question leaked into main context");
	const before = notices.length;
	await request("prompt", { message: "/btw What exact marker did you just reply with? Reply with only that marker." });
	assert.ok(notices.slice(before).some((text) => text.trim() === "RPC_SIDE_OK"), "Side history was not preserved");
	assert.deepEqual((await request("get_messages")).messages, [], "Side history leaked into main context");
	console.log("PASS: both side answers delivered; main conversation remains empty");
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	child.kill();
	await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
}
