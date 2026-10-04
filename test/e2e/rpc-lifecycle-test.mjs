#!/usr/bin/env node
/**
 * Real RPC regression for permission cancellation and queued input delivery.
 * Uses this checkout's permissions extension, not the globally registered package.
 * Usage: node test/e2e/rpc-lifecycle-test.mjs [abort|approve|deny|queue] [model]
 * The approved write stays under .rpc-lifecycle in the checkout. Every child is
 * bounded; abort mode never answers the approval dialog, so it must settle itself.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const scenario = process.argv[2] ?? "abort";
const model = process.argv[3] ?? "anthropic/claude-haiku-4-5";
const root = resolve(import.meta.dirname, "../..");
const workdir = resolve(root, ".rpc-lifecycle");
mkdirSync(workdir, { recursive: true });
const child = spawn("perl", ["-e", "alarm 150; exec @ARGV", "pi", "--mode", "rpc", "--no-extensions", "-e", resolve(root, "extensions/permissions/index.ts"), "-e", resolve(root, "test/e2e/rpc-lifecycle-fixture.ts"), "--permission-mode", "default", "--no-session", "--model", model], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, ONECODE_STATE_DIR: resolve(workdir, "state") },
});
let buffer = "";
let sawPermission = false;
let sawAbort = false;
let queued = false;
let sawNotification = false;
let ended = false;
let timer;
const seenUsers = [];
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const finish = (code) => { clearTimeout(timer); child.kill(); process.exitCode = code; child.stdin.end(); };
const failAfter = (ms) => { clearTimeout(timer); timer = setTimeout(() => { console.log(`TIMEOUT scenario=${scenario} sawPermission=${sawPermission} sawAbort=${sawAbort} ended=${ended} users=${JSON.stringify(seenUsers)}`); finish(2); }, ms); };
failAfter(120_000);
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
		let event; try { event = JSON.parse(line); } catch { continue; }
		if (event.type === "extension_ui_request") {
			console.log(`UI ${event.method}: ${event.title ?? event.message ?? ""}`);
			if (event.method === "select") {
				sawPermission = true;
				if (scenario === "abort") { send({ id: "abort", type: "abort" }); failAfter(3000); }
				else send({ type: "extension_ui_response", id: event.id, value: scenario === "deny" ? "No, tell the agent what to do differently" : "Yes" });
			} else if (event.method === "input") send({ type: "extension_ui_response", id: event.id, value: "Do not write anything; report DENIED." });
		} else if (event.type === "response") {
			console.log(`RESPONSE ${JSON.stringify(event)}`);
			if (event.command === "abort") { sawAbort = true; finish(event.success && ended ? 0 : 2); }
		} else if (event.type === "tool_execution_start") {
			console.log(`TOOL_START ${event.toolName}`);
			if (scenario === "queue" && !queued) {
				queued = true;
				send({ id: "steer", type: "steer", message: "STEER_MARKER: after the tool reply with STEER_SEEN." });
				send({ id: "follow", type: "follow_up", message: "FOLLOW_MARKER: reply only FOLLOW_SEEN." });
				send({ id: "notify", type: "prompt", message: "/rpc-lifecycle-notify" });
			}
		} else if (event.type === "tool_execution_end") console.log(`TOOL_END ${event.toolName}: ${JSON.stringify(event.result)}`);
		else if (event.type === "message_end" && event.message?.role === "custom") {
			const text = typeof event.message.content === "string" ? event.message.content : event.message.content.map((x) => x.text ?? "").join("");
			sawNotification ||= text.includes("NOTIFICATION_MARKER");
			console.log(`NOTIFICATION ${text}`);
		} else if (event.type === "message_end" && event.message?.role === "user") {
			const text = typeof event.message.content === "string" ? event.message.content : event.message.content.map((x) => x.text ?? "").join("");
			seenUsers.push(text); console.log(`USER ${text}`);
		} else if (event.type === "agent_end") {
			ended = true;
			const last = [...(event.messages ?? [])].reverse().find((m) => m.role === "assistant");
			console.log(`AGENT_END ${JSON.stringify(last)}`);
		} else if (event.type === "agent_settled") {
			console.log("AGENT_SETTLED");
			if (scenario !== "abort") finish(sawPermission && (scenario !== "queue" || sawNotification && seenUsers.some((s) => s.includes("STEER_MARKER")) && seenUsers.some((s) => s.includes("FOLLOW_MARKER"))) ? 0 : 2);
		} else if (event.type === "extension_error") console.log(`EXTENSION_ERROR ${JSON.stringify(event)}`);
	}
});
send({ id: "prompt", type: "prompt", message: scenario === "queue" ? "Use the bash tool to run exactly: sleep 2; printf 'WAIT_DONE'. Then reply with DONE." : "Use the write tool to create rpc-test.txt containing hello. You MUST call the write tool; do not just describe the write. Reply only DONE after success or DENIED after refusal." });
