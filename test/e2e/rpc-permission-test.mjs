#!/usr/bin/env node
/**
 * E2E: drive pi in RPC mode, answer the permission prompt programmatically.
 *
 * Usage: node rpc-permission-test.mjs [answer] [workdir]
 *   answer: "Yes" | the scoped grant label (starts "Yes, and …", see
 *           extensions/permissions/session-grant.ts) | "No, tell the agent what to do differently"
 *   workdir: defaults to a new temp dir. pi runs in default permission mode,
 *           so the write asks.
 *
 * Prints PROMPT_SEEN when the permission select arrives, then ANSWERED,
 * then AGENT_DONE when the turn completes. Exits 0 on success.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const answer = process.argv[2] ?? "Yes";
// A throwaway dir by default: the approved write must not land in the checkout.
const workdir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "rpc-permission-"));

const child = spawn("pi", ["--mode", "rpc", "--permission-mode", "default", "--no-session"], {
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
		} else if (event.type === "extension_ui_request" && event.method === "input") {
			// A "No" answer asks what to do instead; skip it (Esc) so the denial lands.
			console.log(`INPUT_SEEN: ${event.title}`);
			send({ type: "extension_ui_response", id: event.id, cancelled: true });
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
