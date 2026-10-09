#!/usr/bin/env node
/**
 * Model-free live RPC smoke for the subagent/workflow panel commands.
 * Loads this checkout's extensions explicitly; no real agents or settings writes.
 * Usage: node test/e2e/rpc-agent-panels-test.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const child = spawn("perl", ["-e", "alarm 45; exec @ARGV", "pi", "--mode", "rpc", "--no-extensions", "--no-session",
	"-e", resolve("extensions/subagents/index.ts"), "-e", resolve("extensions/workflow/index.ts"),
	"-e", resolve("test/e2e/fixtures/rpc-agent-widgets.ts")], {
	stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
const notices = [];
const widgets = new Map();
let id = 0;
const timeout = setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 40_000);
createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try { event = JSON.parse(line); } catch { return; }
	if (event.type === "extension_ui_request" && event.method === "notify") notices.push(event.message);
	if (event.type === "extension_ui_request" && event.method === "setWidget") widgets.set(event.widgetKey, event.widgetLines);
	if (event.type === "response" && pending.has(event.id)) {
		const { resolve, reject } = pending.get(event.id);
		pending.delete(event.id);
		event.success ? resolve(event) : reject(new Error(event.error));
	}
});
const send = (message) => new Promise((resolve, reject) => {
	const requestId = `panel-${++id}`;
	pending.set(requestId, { resolve, reject });
	child.stdin.write(`${JSON.stringify({ type: "prompt", id: requestId, message })}\n`);
});

try {
	for (const [command, expected] of [
		["/tasks", "The interactive task viewer requires TUI mode"],
		["/agents", "Available agents:"],
		["/subagent", "effective:"],
		["/workflows", "The interactive workflow viewer requires TUI mode"],
		["/workflows log missing-id", "No workflow run missing-id in this session"],
		["/workflows stop missing-id", "No running workflow missing-id"],
	]) {
		notices.length = 0;
		await send(command);
		assert(notices.some((message) => message.includes(expected)), `${command}: ${JSON.stringify(notices)}`);
		console.log(`PASS ${command}: ${notices.find((message) => message.includes(expected)).split("\n")[0]}`);
	}
	await send("/rpc-widget-probe");
	assert(widgets.get("subagents")?.join("\n").includes("rpc-agent-1"), "subagent running widget missing");
	assert(widgets.get("workflow")?.join("\n").includes("running"), "workflow running widget missing");
	assert(widgets.get("cc-tasks")?.join("\n").includes("RPC task progress probe"), "task progress widget missing");
	console.log(`PASS running widgets: ${JSON.stringify(Object.fromEntries(widgets))}`);
	await send("/rpc-widget-finish");
	assert(widgets.get("subagents")?.join("\n").includes("/tasks to see subagents"), "subagent completion widget missing");
	assert(widgets.get("workflow")?.join("\n").includes("completed"), "workflow completion widget missing");
	assert(widgets.get("cc-tasks")?.join("\n").includes("1 done"), "task completed widget missing");
	console.log(`PASS completed widgets: ${JSON.stringify(Object.fromEntries(widgets))}`);
	console.log("PASS: all RPC panel commands and status widgets returned visible results");
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	child.kill();
}
