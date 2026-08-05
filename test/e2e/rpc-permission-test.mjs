#!/usr/bin/env node
/**
 * E2E: drive pi in RPC mode, answer the permission prompt programmatically.
 *
 * Usage: node rpc-permission-test.mjs <answer> <workdir>
 *   answer: "Yes" | "Yes, don't ask again this session" | "No, tell the agent what to do differently"
 *
 * Prints PROMPT_SEEN when the permission select arrives, then ANSWERED,
 * then AGENT_DONE when the turn completes. Exits 0 on success.
 */

import { spawn } from "node:child_process";

const answer = process.argv[2] ?? "Yes";
const workdir = process.argv[3] ?? process.cwd();

const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let sawPrompt = false;
let buffer = "";

const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	child.kill();
	process.exit(1);
}, 120_000);

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let idx;
	while ((idx = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.type === "extension_ui_request" && event.method === "select") {
			sawPrompt = true;
			console.log(`PROMPT_SEEN: ${String(event.title).split("\n")[0]}`);
			send({ type: "extension_ui_response", id: event.id, value: answer });
			console.log("ANSWERED");
		} else if (event.type === "agent_end") {
			console.log(`AGENT_DONE prompt_seen=${sawPrompt}`);
			clearTimeout(timeout);
			child.kill();
			process.exit(sawPrompt ? 0 : 2);
		}
	}
});

send({
	id: "req-1",
	type: "prompt",
	message: "Use the write tool to create rpc-test.txt containing 'hello'. Reply exactly: DONE",
});
