#!/usr/bin/env node
/**
 * RPC command smoke: no provider calls, every panel must produce visible output.
 * Loads this checkout's extensions explicitly (not the globally installed package).
 * Usage: node test/e2e/rpc-panels-test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// All state stays in the disposable checkout; this test needs no credentials.
const sandbox = mkdtempSync(join(root, ".rpc-panels-"));
const cwd = join(sandbox, "project");
const home = join(sandbox, "home");
mkdirSync(join(cwd, ".pi"), { recursive: true });
mkdirSync(home);
writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "rpc-panel-fixture-not-a-command" } } }));
const extensions = ["memory", "permissions", "plugins", "skill", "effort", "mcp", "doctor"];
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", ...extensions.flatMap((name) => ["-e", join(root, "extensions", name, "index.ts")]), "--permission-mode", "default"], {
	cwd,
	env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"), ONECODE_STATE_DIR: join(home, ".onecode"), ONECODE_CONFIG_MODE: "independent", ONECODE_NO_UPDATE_CHECK: "1", CLAUDE_CONFIG_DIR: "" },
	stdio: ["pipe", "pipe", "inherit"],
});
let nextId = 0;
const pending = new Map();
const notifications = [];
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
const request = (type, args = {}) => new Promise((resolve, reject) => {
	const id = `test-${++nextId}`;
	pending.set(id, { resolve, reject });
	send({ type, id, ...args });
});
createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try { event = JSON.parse(line); } catch { return; }
	if (event.type === "extension_ui_request") {
		if (event.method === "notify") notifications.push(event.message);
		else if (event.method === "select" || event.method === "input" || event.method === "confirm" || event.method === "editor") {
			console.log(`DIALOG: ${event.method} ${event.title}`);
			send({ type: "extension_ui_response", id: event.id, cancelled: true });
		}
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
}, 60_000);
try {
	await request("get_state");
	for (const [command, expected] of [
		["/memory", /RPC.*TUI/],
		["/permissions", /RPC.*TUI/],
		["/add-dir", /\/add-dir <path>/],
		["/plugins", /RPC.*TUI/],
		["/skills", /RPC.*TUI/],
		["/effort", /Current effort/],
		["/auto-mode config", /classifier in use:/],
		["/mcp", /RPC.*TUI/],
		["/doctor report", /One Code doctor/],
	]) {
		const before = notifications.length;
		await request("prompt", { message: command });
		const output = notifications.slice(before).join("\n");
		assert.match(output, expected, command);
		assert.doesNotMatch(output, /Cancelled memory editing/);
		console.log(`PASS ${command}: ${output.split("\n").find((line) => expected.test(line))}`);
	}
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	child.kill();
	await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
	rmSync(sandbox, { recursive: true, force: true });
}
