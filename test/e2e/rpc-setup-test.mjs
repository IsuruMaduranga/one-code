#!/usr/bin/env node
/**
 * E2E: drive `/auto-mode setup` over RPC, answering its dialogs.
 *
 * Usage: node rpc-setup-test.mjs <workdir>
 *
 * Answers: usage=first option, shell history=No, save=Discard, audit=Leave —
 * so a run against the real user settings NEVER writes anything. Prints each
 * dialog as SELECT:<title>, each notification as NOTIFY:<first line>, and
 * PROPOSAL_SEEN when the drafted proposal notification arrives. Exits 0 once
 * the flow completes with a proposal seen.
 */

import { spawn } from "node:child_process";

const workdir = process.argv[2] ?? process.cwd();

const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let sawProposal = false;
let done = false;
let buffer = "";

const finish = (code) => {
	if (done) return;
	done = true;
	child.kill();
	process.exit(code);
};

const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	finish(1);
}, 240_000);

const answerFor = (title) => {
	if (title.startsWith("How do you use")) return "Software development in this repo";
	if (title.startsWith("Also scan recent shell history")) return "No";
	if (title.startsWith("Save this auto-mode setup")) return "Discard";
	if (title.startsWith("Remove them from user settings")) return "Leave them";
	return undefined;
};

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
			const title = String(event.title ?? "");
			console.log(`SELECT: ${title.split("\n")[0]}`);
			const value = answerFor(title);
			if (!value) {
				console.error(`UNEXPECTED_SELECT: ${title}`);
				return finish(3);
			}
			send({ type: "extension_ui_response", id: event.id, value });
			if (title.startsWith("Save this auto-mode setup")) {
				// Discard is the last required interaction unless the audit fires; give
				// the handler a beat to finish (or ask its audit question) then exit.
				setTimeout(() => {
					clearTimeout(timeout);
					console.log(`FLOW_DONE proposal_seen=${sawProposal}`);
					finish(sawProposal ? 0 : 2);
				}, 5_000);
			}
		} else if (event.type === "extension_ui_request" && event.method === "notify") {
			const message = String(event.message ?? "");
			console.log(`NOTIFY: ${message.split("\n")[0]}`);
			if (message.startsWith("Proposed auto-mode setup")) {
				sawProposal = true;
				console.log("PROPOSAL_SEEN");
				console.log(message.split("\n").slice(0, 40).join("\n"));
			}
		}
	}
});

send({ id: "req-1", type: "prompt", message: "/auto-mode setup" });
